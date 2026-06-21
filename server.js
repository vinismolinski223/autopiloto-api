const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");


const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const TMP = "/tmp/autopiloto";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "oArP4WehPe3qjqvCwHNo";
const REPLICATE_KEY = process.env.REPLICATE_KEY;
const DRIVE_FOLDER_ID = "1gVxvfFtEYlCHzbTBogIzc_rKsKSHm0dg";

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get("/status", (req, res) => res.json({ status: "online", version: "2.0.0", timestamp: new Date().toISOString() }));

function rodarFFmpeg(comando) {
  return new Promise((resolve, reject) => {
    exec(comando, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function baixarArquivo(url, destino) {
  const res = await axios({ url, responseType: "arraybuffer", timeout: 60000 });
  fs.writeFileSync(destino, Buffer.from(res.data));
  return destino;
}

async function gerarRoteiro(tema) {
  const res = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `Você é roteirista especialista em YouTube sobre automação e IA para negócios brasileiros.

Crie roteiro narrado para o canal "AutoPiloto" sobre: "${tema}"

Regras:
- Linguagem direta e acessível para empreendedores
- Duração: 5-6 minutos narrados
- Estrutura: gancho forte → problema → solução em 3 blocos → CTA
- Retorne APENAS o texto narrado corrido, pronto para voz de IA

Após o roteiro, retorne exatamente 4 prompts visuais em inglês:
CLIP1: [cena cinematográfica relacionada ao tema]
CLIP2: [cena cinematográfica relacionada ao tema]
CLIP3: [cena cinematográfica relacionada ao tema]
CLIP4: [cena cinematográfica relacionada ao tema]`
    }]
  }, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }
  });
  return res.data.content?.map(b => b.text || "").join("") || "";
}

async function gerarNarracao(texto, pasta) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    { text: texto.slice(0, 2500), model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8 } },
    { headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
  );
  const audioPath = path.join(pasta, "narracao.mp3");
  fs.writeFileSync(audioPath, Buffer.from(res.data));
  return audioPath;
}

async function gerarClipe(prompt, index, pasta) {
  const res = await axios.post(
    "https://api.replicate.com/v1/models/kwaivgi/kling-v3-video/predictions",
    { input: { prompt, duration: 5, aspect_ratio: "16:9", cfg_scale: 0.5 } },
    { headers: { "Authorization": `Bearer ${REPLICATE_KEY}`, "Content-Type": "application/json", "Prefer": "wait=60" } }
  );

  let prediction = res.data;
  let tentativas = 0;
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && tentativas < 30) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { "Authorization": `Bearer ${REPLICATE_KEY}` }
    });
    prediction = poll.data;
    tentativas++;
  }

  if (prediction.status !== "succeeded") throw new Error(`Clipe ${index + 1} falhou`);

  const clipUrl = prediction.output?.[0] || prediction.output;
  const clipPath = path.join(pasta, `clip_${index}.mp4`);
  await baixarArquivo(clipUrl, clipPath);
  return clipPath;
}

app.post("/gerar-video", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const pasta = path.join(TMP, jobId);
  fs.mkdirSync(pasta, { recursive: true });
  console.log(`[${jobId}] Iniciando pipeline completo...`);

  try {
    const { tema } = req.body;
    if (!tema) return res.status(400).json({ erro: "tema é obrigatório" });

    // 1. Roteiro
    console.log(`[${jobId}] Gerando roteiro...`);
    const textoCompleto = await gerarRoteiro(tema);
    const linhas = textoCompleto.split("\n");
    const promptsClipes = linhas.filter(l => l.match(/^CLIP\d:/)).map(l => l.replace(/^CLIP\d:\s*/, "").trim());
    const textoRoteiro = linhas.filter(l => !l.match(/^CLIP\d:/)).join("\n").trim();
    console.log(`[${jobId}] Roteiro pronto!`);

    // 2. Narração
    console.log(`[${jobId}] Gerando narração...`);
    const audioPath = await gerarNarracao(textoRoteiro, pasta);
    console.log(`[${jobId}] Narração pronta!`);

    // 3. Clipes
    const prompts = promptsClipes.length >= 3 ? promptsClipes : [
      "A businessman looking at futuristic AI holographic dashboard, cinematic dark lighting",
      "Robotic hands automating digital tasks on glowing screens, tech 4K cinematic",
      "WhatsApp messages and AI data flowing through digital space, neural network",
      "Entrepreneur smiling at phone showing automation results, modern office golden hour",
    ];

    const clipPaths = [];
    for (let i = 0; i < Math.min(prompts.length, 4); i++) {
      try {
        console.log(`[${jobId}] Gerando clipe ${i + 1}...`);
        const clipPath = await gerarClipe(prompts[i], i, pasta);
        clipPaths.push(clipPath);
        console.log(`[${jobId}] Clipe ${i + 1} pronto!`);
      } catch (e) {
        console.log(`[${jobId}] Clipe ${i + 1} falhou: ${e.message}`);
      }
    }

    if (clipPaths.length === 0) throw new Error("Nenhum clipe foi gerado com sucesso");

    // 4. Montar vídeo
    console.log(`[${jobId}] Montando vídeo final...`);
    const listaLoop = [...clipPaths, ...clipPaths, ...clipPaths].map(p => `file '${p}'`).join("\n");
    const listaPath = path.join(pasta, "lista.txt");
    fs.writeFileSync(listaPath, listaLoop);

    const concatPath = path.join(pasta, "concat.mp4");
    await rodarFFmpeg(`ffmpeg -f concat -safe 0 -i "${listaPath}" -c copy "${concatPath}" -y`);

    const duracaoAudio = await new Promise(resolve => {
      exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`, (err, stdout) => {
        resolve(parseFloat(stdout?.trim()) || 300);
      });
    });

    const videoFinalPath = path.join(pasta, "video_final.mp4");
    await rodarFFmpeg(
      `ffmpeg -i "${concatPath}" -i "${audioPath}" -t ${duracaoAudio} ` +
      `-map 0:v -map 1:a -c:v libx264 -c:a aac -b:a 192k ` +
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,` +
      `drawtext=fontsize=40:fontcolor=white:alpha=0.7:x=(w-text_w)/2:y=h-70:text='AutoPiloto':box=1:boxcolor=black@0.4:boxborderw=10" ` +
      `-preset fast -crf 23 "${videoFinalPath}" -y`
    );

    const videoBuffer = fs.readFileSync(videoFinalPath);
    const tamanhoMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[${jobId}] Vídeo pronto! ${tamanhoMB}MB`);

    setTimeout(() => { try { fs.rmSync(pasta, { recursive: true }); } catch (e) {} }, 120000);

    res.json({
      sucesso: true,
      jobId,
      tamanhoMB,
      duracaoSegundos: Math.round(duracaoAudio),
      roteiro: textoRoteiro,
      videoBase64: videoBuffer.toString("base64"),
      driveUrl: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
      mensagem: `Vídeo de ${Math.round(duracaoAudio)}s gerado com sucesso!`
    });

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    res.status(500).json({ erro: erro.message, jobId });
  }
});

app.listen(PORT, () => console.log(`🚀 AutoPiloto API v2 rodando na porta ${PORT}`));
