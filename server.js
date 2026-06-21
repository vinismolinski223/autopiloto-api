const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const FormData = require("form-data");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
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

app.get("/status", (req, res) => res.json({ status: "online", version: "2.0.0" }));

function rodar(comando) {
  return new Promise((resolve, reject) => {
    exec(comando, { maxBuffer: 1024 * 1024 * 500 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function baixarVideo(url, pasta) {
  console.log(`Baixando vídeo: ${url}`);
  const videoPath = path.join(pasta, "video.mp4");
  
  // Usar cookies do arquivo no repositório
  const cookiesPath = path.join(__dirname, "cookies.txt");
  const cookiesFlag = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
  if (cookiesFlag) console.log("Usando cookies do YouTube!");
  await rodar(`yt-dlp ${cookiesFlag} --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "${videoPath}" "${url}"`);
  return videoPath;
}

async function extrairAudio(videoPath, pasta) {
  console.log("Extraindo áudio...");
  const audioPath = path.join(pasta, "audio.mp3");
  await rodar(`ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 64k "${audioPath}" -y`);
  return audioPath;
}

async function transcreverAssemblyAI(audioPath) {
  console.log("Enviando áudio pro AssemblyAI...");
  
  // Upload do arquivo
  const audioData = fs.readFileSync(audioPath);
  const uploadRes = await axios.post("https://api.assemblyai.com/v2/upload", audioData, {
    headers: {
      "authorization": ASSEMBLYAI_KEY,
      "content-type": "application/octet-stream",
    },
    maxBodyLength: Infinity,
  });
  const uploadUrl = uploadRes.data.upload_url;
  console.log("Áudio enviado! Iniciando transcrição...");

  // Iniciar transcrição
  const transcricaoRes = await axios.post("https://api.assemblyai.com/v2/transcript", {
    audio_url: uploadUrl,
    language_code: "pt",
    timestamps_type: "word",
  }, {
    headers: { "authorization": ASSEMBLYAI_KEY }
  });
  
  const transcricaoId = transcricaoRes.data.id;
  console.log(`Transcrição iniciada: ${transcricaoId}`);

  // Polling até completar
  let resultado;
  let tentativas = 0;
  while (tentativas < 120) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcricaoId}`, {
      headers: { "authorization": ASSEMBLYAI_KEY }
    });
    resultado = statusRes.data;
    console.log(`Transcrição status: ${resultado.status}`);
    
    if (resultado.status === "completed") break;
    if (resultado.status === "error") throw new Error(`AssemblyAI erro: ${resultado.error}`);
    tentativas++;
  }

  if (resultado.status !== "completed") throw new Error("Transcrição demorou muito");
  
  console.log(`Transcrição completa! ${resultado.words?.length} palavras`);
  return resultado;
}

async function analisarMelhoresMomentos(transcricao, titulo) {
  console.log("Analisando melhores momentos com Claude...");
  
  // Montar texto com timestamps dos utterances
  const texto = transcricao.text || "";
  const palavras = transcricao.words || [];
  
  // Criar segmentos de 30 segundos
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

  const textoSegmentado = segmentos.map(s => 
    `[${s.inicio}s-${s.fim}s] ${s.texto.trim()}`
  ).join("\n");

  const res = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `Você é especialista em criar cortes virais de podcast para YouTube Shorts brasileiros.

Analise essa transcrição do vídeo "${titulo}" e escolha os 5 melhores momentos para virar Shorts virais.

Critérios:
- Momentos impactantes, engraçados, reveladores ou polêmicos
- Falas que geram curiosidade ou debate
- Histórias com começo meio e fim
- Duração ideal: 45 a 90 segundos cada
- Não cortar no meio de raciocínio importante

TRANSCRIÇÃO:
${textoSegmentado.slice(0, 8000)}

Retorne APENAS JSON válido sem markdown:
{
  "cortes": [
    {
      "inicio": 45,
      "fim": 112,
      "titulo": "Título chamativo pro Short",
      "descricao": "Descrição com hashtags pra YouTube",
      "motivo": "Por que esse momento é viral"
    }
  ]
}`
    }]
  }, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }
  });

  const texto2 = res.data.content?.map(b => b.text || "").join("") || "";
  const clean = texto2.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function cortarVideo(videoPath, inicio, fim, index, pasta) {
  console.log(`Cortando clipe ${index + 1}: ${inicio}s - ${fim}s`);
  const clipPath = path.join(pasta, `corte_${index + 1}.mp4`);
  const duracao = fim - inicio;
  
  await rodar(
    `ffmpeg -i "${videoPath}" -ss ${inicio} -t ${duracao} ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
    `-c:v libx264 -c:a aac -b:a 192k -preset fast -crf 23 "${clipPath}" -y`
  );
  
  return clipPath;
}

app.post("/gerar-cortes", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const pasta = path.join(TMP, jobId);
  fs.mkdirSync(pasta, { recursive: true });
  console.log(`[${jobId}] Iniciando ClipForge...`);

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ erro: "URL é obrigatória" });

    // 1. Info do vídeo
    console.log(`[${jobId}] Obtendo info...`);
    const infoRaw = await rodar(`yt-dlp --dump-json "${url}"`);
    const info = JSON.parse(infoRaw);
    const titulo = info.title || "Vídeo";
    const duracao = info.duration || 0;
    console.log(`[${jobId}] "${titulo}" | ${duracao}s`);

    // 2. Baixar vídeo
    const videoPath = await baixarVideo(url, pasta);
    console.log(`[${jobId}] Vídeo baixado!`);

    // 3. Extrair áudio
    const audioPath = await extrairAudio(videoPath, pasta);

    // 4. Transcrever com AssemblyAI
    const transcricao = await transcreverAssemblyAI(audioPath);

    // 5. Analisar melhores momentos
    const analise = await analisarMelhoresMomentos(transcricao, titulo);
    console.log(`[${jobId}] ${analise.cortes.length} momentos identificados!`);

    // 6. Cortar vídeos
    const cortesFinais = [];
    for (let i = 0; i < Math.min(analise.cortes.length, 5); i++) {
      const corte = analise.cortes[i];
      try {
        const clipPath = await cortarVideo(videoPath, corte.inicio, corte.fim, i, pasta);
        const videoBuffer = fs.readFileSync(clipPath);
        cortesFinais.push({
          index: i + 1,
          titulo: corte.titulo,
          descricao: corte.descricao,
          inicio: corte.inicio,
          fim: corte.fim,
          duracao: corte.fim - corte.inicio,
          tamanhoMB: (videoBuffer.length / 1024 / 1024).toFixed(1),
          videoBase64: videoBuffer.toString("base64"),
        });
        console.log(`[${jobId}] Corte ${i + 1} pronto!`);
      } catch (e) {
        console.log(`[${jobId}] Corte ${i + 1} falhou: ${e.message}`);
      }
    }

    setTimeout(() => { try { fs.rmSync(pasta, { recursive: true }); } catch (e) {} }, 300000);

    res.json({
      sucesso: true,
      jobId,
      tituloOriginal: titulo,
      duracaoOriginal: duracao,
      totalCortes: cortesFinais.length,
      cortes: cortesFinais,
      mensagem: `${cortesFinais.length} cortes gerados!`
    });

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    res.status(500).json({ erro: erro.message, jobId });
  }
});

app.listen(PORT, () => console.log(`🚀 ClipForge API v2 rodando na porta ${PORT}`));
