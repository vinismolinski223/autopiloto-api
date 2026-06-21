const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  }
}));

const PORT = process.env.PORT || 3000;
const TMP = "/tmp/clipforge";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Storage para upload de vídeo
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// Fila de jobs em memória
const jobs = {};

app.get("/status", (req, res) => res.json({ status: "online", version: "4.0.0" }));

// Painel solicita novo job
app.post("/solicitar-cortes", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ erro: "URL obrigatória" });
  
  const jobId = uuidv4().slice(0, 8);
  jobs[jobId] = { id: jobId, url, status: "pending", criadoEm: Date.now() };
  
  console.log(`[${jobId}] Novo job criado: ${url}`);
  res.json({ sucesso: true, jobId, mensagem: "Job criado! Aguardando agent no PC..." });
});

// Agent no PC busca jobs pendentes
app.get("/jobs-pendentes", (req, res) => {
  const pendentes = Object.values(jobs).filter(j => j.status === "pending");
  res.json({ jobs: pendentes });
});

// Agent atualiza status
app.post("/job-status", (req, res) => {
  const { jobId, status, erro } = req.body;
  if (jobs[jobId]) {
    jobs[jobId].status = status;
    if (erro) jobs[jobId].erro = erro;
    console.log(`[${jobId}] Status: ${status}`);
  }
  res.json({ ok: true });
});

// Agent envia vídeo baixado
app.post("/processar-video", upload.single("video"), async (req, res) => {
  const { jobId } = req.body;
  const videoPath = req.file?.path;
  
  if (!jobId || !videoPath) return res.status(400).json({ erro: "jobId e video obrigatórios" });
  
  const pasta = path.join(TMP, jobId);
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
  
  // Mover vídeo pra pasta do job
  const videoFinal = path.join(pasta, "video.mp4");
  fs.renameSync(videoPath, videoFinal);
  
  console.log(`[${jobId}] Vídeo recebido! Processando...`);
  jobs[jobId].status = "processing";

  // Processar em background
  processarVideo(jobId, videoFinal, jobs[jobId].url);
  
  res.json({ sucesso: true, mensagem: "Vídeo recebido! Processando..." });
});

// Painel verifica resultado
app.get("/resultado/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: "Job não encontrado" });
  res.json(job);
});

function rodar(comando) {
  return new Promise((resolve, reject) => {
    exec(comando, { maxBuffer: 1024 * 1024 * 500 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function processarVideo(jobId, videoPath, url) {
  const pasta = path.dirname(videoPath);
  
  try {
    // 1. Extrair áudio
    console.log(`[${jobId}] Extraindo áudio...`);
    const audioPath = path.join(pasta, "audio.mp3");
    await rodar(`ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 64k "${audioPath}" -y`);

    // 2. Transcrever
    console.log(`[${jobId}] Transcrevendo...`);
    const audioData = fs.readFileSync(audioPath);
    const uploadRes = await axios.post("https://api.assemblyai.com/v2/upload", audioData, {
      headers: { "authorization": ASSEMBLYAI_KEY, "content-type": "application/octet-stream" },
      maxBodyLength: Infinity,
    });

    const transcricaoRes = await axios.post("https://api.assemblyai.com/v2/transcript", {
      audio_url: uploadRes.data.upload_url,
      language_code: "pt",
      format_text: true,
    }, { headers: { "authorization": ASSEMBLYAI_KEY, "content-type": "application/json" } });

    let resultado;
    let tentativas = 0;
    while (tentativas < 120) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcricaoRes.data.id}`, {
        headers: { "authorization": ASSEMBLYAI_KEY }
      });
      resultado = statusRes.data;
      console.log(`[${jobId}] Transcrição: ${resultado.status}`);
      if (resultado.status === "completed") break;
      if (resultado.status === "error") throw new Error(`AssemblyAI: ${resultado.error}`);
      tentativas++;
    }

    // 3. Analisar com Claude
    console.log(`[${jobId}] Analisando com Claude...`);
    const palavras = resultado.words || [];
    const segmentos = [];
    let segAtual = { inicio: 0, fim: 0, texto: "" };
    palavras.forEach(p => {
      const inicio = Math.floor(p.start / 1000);
      const fim = Math.floor(p.end / 1000);
      if (inicio - segAtual.inicio > 30 && segAtual.texto) {
        segmentos.push({ ...segAtual });
        segAtual = { inicio, fim, texto: p.text + " " };
      } else {
        segAtual.fim = fim;
        segAtual.texto += p.text + " ";
      }
    });
    if (segAtual.texto) segmentos.push(segAtual);

    const textoSegmentado = segmentos.map(s => `[${s.inicio}s-${s.fim}s] ${s.texto.trim()}`).join("\n");

    const claudeRes = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Analise essa transcrição e escolha os 5 melhores momentos para YouTube Shorts virais brasileiros.

Critérios: momentos impactantes, engraçados, reveladores. Duração: 45-90 segundos cada.

TRANSCRIÇÃO:
${textoSegmentado.slice(0, 8000)}

Retorne APENAS JSON sem markdown:
{"cortes":[{"inicio":45,"fim":112,"titulo":"Título chamativo","descricao":"Descrição com hashtags","motivo":"Por que é viral"}]}`
      }]
    }, { headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } });

    const textoClaud = claudeRes.data.content?.map(b => b.text || "").join("") || "";
    const analise = JSON.parse(textoClaud.replace(/```json|```/g, "").trim());

    // 4. Cortar vídeos
    console.log(`[${jobId}] Cortando ${analise.cortes.length} clipes...`);
    const cortesFinais = [];
    for (let i = 0; i < Math.min(analise.cortes.length, 5); i++) {
      const corte = analise.cortes[i];
      try {
        const clipPath = path.join(pasta, `corte_${i + 1}.mp4`);
        await rodar(
          `ffmpeg -i "${videoPath}" -ss ${corte.inicio} -t ${corte.fim - corte.inicio} ` +
          `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
          `-c:v libx264 -c:a aac -b:a 192k -preset fast -crf 23 "${clipPath}" -y`
        );
        const buf = fs.readFileSync(clipPath);
        cortesFinais.push({
          index: i + 1,
          titulo: corte.titulo,
          descricao: corte.descricao,
          duracao: corte.fim - corte.inicio,
          tamanhoMB: (buf.length / 1024 / 1024).toFixed(1),
          videoBase64: buf.toString("base64"),
        });
        console.log(`[${jobId}] Corte ${i + 1} pronto!`);
      } catch (e) {
        console.log(`[${jobId}] Corte ${i + 1} falhou: ${e.message}`);
      }
    }

    jobs[jobId].status = "completed";
    jobs[jobId].cortes = cortesFinais;
    jobs[jobId].totalCortes = cortesFinais.length;
    console.log(`[${jobId}] ✅ Concluído! ${cortesFinais.length} cortes prontos!`);

    setTimeout(() => { try { fs.rmSync(pasta, { recursive: true }); } catch (e) {} }, 300000);

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    jobs[jobId].status = "error";
    jobs[jobId].erro = erro.message;
  }
}

app.listen(PORT, () => console.log(`🚀 ClipForge API v4 rodando na porta ${PORT}`));
