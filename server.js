const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

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

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get("/status", (req, res) => res.json({ status: "online", version: "1.0.0" }));

function rodar(comando, opcoes = {}) {
  return new Promise((resolve, reject) => {
    exec(comando, { maxBuffer: 1024 * 1024 * 500, ...opcoes }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function baixarVideo(url, pasta) {
  console.log(`Baixando vídeo: ${url}`);
  const videoPath = path.join(pasta, "video.mp4");
  await rodar(`yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "${videoPath}" "${url}"`);
  return videoPath;
}

async function transcreverAudio(videoPath, pasta) {
  console.log("Transcrevendo áudio com Whisper...");
  const audioPath = path.join(pasta, "audio.mp3");
  await rodar(`ffmpeg -i "${videoPath}" -vn -ar 16000 -ac 1 -b:a 64k "${audioPath}" -y`);
  
  const transcricaoPath = path.join(pasta, "transcricao.json");
  await rodar(`python3 -c "
import whisper, json
model = whisper.load_model('base')
result = model.transcribe('${audioPath}', language='pt', word_timestamps=True)
with open('${transcricaoPath}', 'w') as f:
    json.dump(result, f, ensure_ascii=False)
print('Transcrição concluída!')
"`);
  
  const transcricao = JSON.parse(fs.readFileSync(transcricaoPath, "utf8"));
  return transcricao;
}

async function analisarMelhoresMomentos(transcricao, titulo) {
  console.log("Analisando melhores momentos com Claude...");
  
  // Preparar texto com timestamps
  const segmentos = transcricao.segments.map(s => 
    `[${Math.floor(s.start)}s-${Math.floor(s.end)}s] ${s.text}`
  ).join("\n");

  const res = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `Você é especialista em criar cortes virais de podcast para YouTube Shorts.

Analise essa transcrição do vídeo "${titulo}" e escolha os 5 melhores momentos para virar Shorts virais.

Critérios para escolher:
- Momentos impactantes, engraçados ou reveladores
- Falas que geram curiosidade ou polêmica
- Histórias interessantes com começo, meio e fim
- Duração ideal: 45 a 90 segundos cada
- Evitar cortes no meio de uma frase importante

TRANSCRIÇÃO:
${segmentos.slice(0, 8000)}

Retorne APENAS um JSON válido neste formato exato, sem markdown:
{
  "cortes": [
    {
      "inicio": 45,
      "fim": 112,
      "titulo": "Título chamativo pra Short",
      "descricao": "Descrição curta pra YouTube com hashtags",
      "motivo": "Por que esse momento é viral"
    }
  ]
}`
    }]
  }, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }
  });

  const texto = res.data.content?.map(b => b.text || "").join("") || "";
  const clean = texto.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function cortarVideo(videoPath, inicio, fim, index, pasta) {
  console.log(`Cortando clipe ${index + 1}: ${inicio}s - ${fim}s`);
  const clipPath = path.join(pasta, `corte_${index + 1}.mp4`);
  const duracao = fim - inicio;
  
  await rodar(
    `ffmpeg -i "${videoPath}" -ss ${inicio} -t ${duracao} ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `fontsize=24:fontcolor=white:x=(w-text_w)/2:y=h-80:` +
    `text='ClipForge.app':box=1:boxcolor=black@0.4:boxborderw=6" ` +
    `-c:v libx264 -c:a aac -b:a 192k -preset fast -crf 23 "${clipPath}" -y`
  );
  
  return clipPath;
}

app.post("/gerar-cortes", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const pasta = path.join(TMP, jobId);
  fs.mkdirSync(pasta, { recursive: true });
  console.log(`[${jobId}] Iniciando pipeline de cortes...`);

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ erro: "URL é obrigatória" });

    // 1. Pegar info do vídeo
    console.log(`[${jobId}] Obtendo info do vídeo...`);
    const infoRaw = await rodar(`yt-dlp --dump-json "${url}"`);
    const info = JSON.parse(infoRaw);
    const titulo = info.title || "Vídeo";
    const duracao = info.duration || 0;
    console.log(`[${jobId}] Título: ${titulo} | Duração: ${duracao}s`);

    // 2. Baixar vídeo
    const videoPath = await baixarVideo(url, pasta);
    console.log(`[${jobId}] Vídeo baixado!`);

    // 3. Transcrever
    const transcricao = await transcreverAudio(videoPath, pasta);
    console.log(`[${jobId}] Transcrição pronta! ${transcricao.segments.length} segmentos`);

    // 4. Analisar melhores momentos
    const analise = await analisarMelhoresMomentos(transcricao, titulo);
    console.log(`[${jobId}] ${analise.cortes.length} melhores momentos identificados`);

    // 5. Cortar vídeos
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
      mensagem: `${cortesFinais.length} cortes gerados com sucesso!`
    });

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    res.status(500).json({ erro: erro.message, jobId });
  }
});

app.listen(PORT, () => console.log(`🚀 ClipForge API v1 rodando na porta ${PORT}`));
