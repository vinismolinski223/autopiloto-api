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
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  }
}));

const PORT = process.env.PORT || 3000;
const TMP = "/tmp/autopiloto";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "oArP4WehPe3qjqvCwHNo";
const REPLICATE_KEY = process.env.REPLICATE_KEY;

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

app.get("/status", (req, res) => res.json({ status: "online", version: "3.0.0" }));

function rodarFFmpeg(comando) {
  return new Promise((resolve, reject) => {
    exec(comando, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function baixarArquivo(url, destino) {
  const res = await axios({ url, responseType: "arraybuffer", timeout: 120000 });
  fs.writeFileSync(destino, Buffer.from(res.data));
  return destino;
}

async function gerarRoteiro(caso) {
  const res = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `Você é roteirista especialista em True Crime brasileiro para YouTube Shorts.

Crie um roteiro narrado para um Short sobre: "${caso}"

Regras:
- Duração: 90 segundos a 3 minutos de narração
- Tom: sombrio, tenso, dramático — prende do primeiro segundo
- Linguagem: acessível, brasileira, informal
- Estrutura: gancho chocante → contexto → desenvolvimento → revelação → CTA
- O gancho deve ser nos primeiros 3 segundos — algo que choca
- Baseado em fatos reais verificáveis
- Termine com "Segue o canal pra mais casos assim"

Retorne APENAS o texto narrado corrido, pronto para voz de IA.

Após o roteiro, retorne entre 8 e 12 prompts visuais em inglês para clipes cinematográficos sombrios:
CLIP1: [cena sombria e cinematográfica relacionada ao caso]
CLIP2: [cena]
CLIP3: [cena]
CLIP4: [cena]
CLIP5: [cena]
CLIP6: [cena]
CLIP7: [cena]
CLIP8: [cena]
CLIP9: [cena]
CLIP10: [cena]`
    }]
  }, {
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }
  });
  return res.data.content?.map(b => b.text || "").join("") || "";
}

async function gerarNarracao(texto, pasta) {
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: texto.slice(0, 2500),
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true }
    },
    { headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_KEY }, responseType: "arraybuffer" }
  );
  const audioPath = path.join(pasta, "narracao.mp3");
  fs.writeFileSync(audioPath, Buffer.from(res.data));
  return audioPath;
}

async function gerarClipe(prompt, index, pasta) {
  // Kling 3.0 - melhor qualidade cinematografica
  const promptSombrio = prompt + ", dark cinematic, dramatic lighting, high quality, 4K, film noir style";
  
  const res = await axios.post(
    "https://api.replicate.com/v1/models/kwaivgi/kling-v3-video/predictions",
    {
      input: {
        prompt: promptSombrio,
        duration: 5,
        aspect_ratio: "9:16",
        cfg_scale: 0.5,
        negative_prompt: "blurry, low quality, cartoon, animation, bright colors"
      }
    },
    { headers: { "Authorization": `Bearer ${REPLICATE_KEY}`, "Content-Type": "application/json" } }
  );

  let prediction = res.data;
  console.log(`Clipe ${index + 1} iniciado: ${prediction.id} status: ${prediction.status}`);
  if (prediction.error) throw new Error(`Kling error: ${JSON.stringify(prediction.error)}`);

  let tentativas = 0;
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && tentativas < 60) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { "Authorization": `Bearer ${REPLICATE_KEY}` }
    });
    prediction = poll.data;
    tentativas++;
    console.log(`Clipe ${index + 1} status: ${prediction.status}`);
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`Clipe ${index + 1} falhou: ${JSON.stringify(prediction.error)}`);
  }

  let clipUrl = null;
  if (typeof prediction.output === "string") clipUrl = prediction.output;
  else if (Array.isArray(prediction.output)) clipUrl = prediction.output[0];
  else if (prediction.output?.url) clipUrl = prediction.output.url;

  console.log(`Clipe ${index + 1} URL: ${clipUrl}`);

  if (!clipUrl || clipUrl === "null") {
    throw new Error(`Clipe ${index + 1} URL invalida: ${JSON.stringify(prediction.output)}`);
  }

  const clipPath = path.join(pasta, `clip_${index}.mp4`);
  await baixarArquivo(clipUrl, clipPath);
  return clipPath;
}

app.post("/gerar-video", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const pasta = path.join(TMP, jobId);
  fs.mkdirSync(pasta, { recursive: true });
  console.log(`[${jobId}] Iniciando Short de True Crime...`);

  try {
    const { tema } = req.body;
    if (!tema) return res.status(400).json({ erro: "tema é obrigatório" });

    // 1. Roteiro
    console.log(`[${jobId}] Gerando roteiro True Crime...`);
    const textoCompleto = await gerarRoteiro(tema);
    const linhas = textoCompleto.split("\n");
    const promptsClipes = linhas.filter(l => l.match(/^CLIP\d+:/)).map(l => l.replace(/^CLIP\d+:\s*/, "").trim());
    const textoRoteiro = linhas.filter(l => !l.match(/^CLIP\d+:/)).join("\n").trim();
    console.log(`[${jobId}] Roteiro pronto! ${promptsClipes.length} prompts gerados.`);

    // 2. Narracao
    console.log(`[${jobId}] Gerando narracao...`);
    const audioPath = await gerarNarracao(textoRoteiro, pasta);
    console.log(`[${jobId}] Narracao pronta!`);

    // 3. Duracao do audio
    const duracaoAudio = await new Promise(resolve => {
      exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`, (err, stdout) => {
        resolve(parseFloat(stdout?.trim()) || 90);
      });
    });
    console.log(`[${jobId}] Duracao do audio: ${duracaoAudio}s`);

    // 4. Calcular quantos clipes precisamos (1 clipe de 5s a cada 8s de video)
    const numClipes = 4; // 4 clipes de 5s em loop cobrem qualquer duracao
    console.log(`[${jobId}] Gerando ${numClipes} clipes...`);

    // Prompts padrao sombrios pra True Crime caso nao tenha suficientes
    const promptsPadrao = [
      "Dark rainy city street at night, police car lights reflecting on wet pavement, cinematic",
      "Close up of crime scene investigation documents and evidence bags, dramatic lighting",
      "Mysterious figure walking through dark corridor, shadows and tension, film noir",
      "Brazilian courthouse exterior at dusk, dramatic clouds, cinematic atmosphere",
      "Hands counting money in darkness, shady criminal activity, dramatic shadows",
      "Security camera footage aesthetic, grainy black and white, suspicious person",
      "Detective examining evidence board with photos and strings, dark office, tense",
      "Prison bars casting shadows on concrete floor, dramatic lighting, cinematic",
      "Newspaper headlines about crime spinning in darkness, dramatic reveal",
      "Dark alley in Brazilian city at night, tension and mystery, cinematic",
      "Judge gavel striking in dark courtroom, dramatic lighting",
      "Fingerprint being revealed under forensic light, dark background",
    ];

    const prompts = promptsClipes.length >= 6 ? promptsClipes.slice(0, numClipes) : promptsPadrao.slice(0, numClipes);

    // 5. Gerar clipes em paralelo (grupos de 3 pra nao sobrecarregar)
    const clipPaths = [];
    for (let i = 0; i < numClipes; i++) {
      try {
        console.log(`[${jobId}] Gerando clipe ${i + 1}/${numClipes}...`);
        const clipPath = await gerarClipe(prompts[i] || promptsPadrao[i % promptsPadrao.length], i, pasta);
        clipPaths.push(clipPath);
        console.log(`[${jobId}] Clipe ${i + 1} pronto!`);
      } catch (e) {
        console.log(`[${jobId}] Clipe ${i + 1} falhou: ${e.message}`);
      }
    }

    if (clipPaths.length === 0) throw new Error("Nenhum clipe foi gerado com sucesso");
    console.log(`[${jobId}] ${clipPaths.length} clipes gerados com sucesso!`);

    // 6. Montar video vertical 9:16
    console.log(`[${jobId}] Montando Short vertical...`);

    // Lista de clipes em loop ate cobrir o audio
    const listaLoop = [];
    let duracaoTotal = 0;
    while (duracaoTotal < duracaoAudio + 10) {
      for (const p of clipPaths) {
        listaLoop.push(`file '${p}'`);
        duracaoTotal += 5;
        if (duracaoTotal >= duracaoAudio + 10) break;
      }
    }
    const listaPath = path.join(pasta, "lista.txt");
    fs.writeFileSync(listaPath, listaLoop.join("\n"));

    const concatPath = path.join(pasta, "concat.mp4");
    await rodarFFmpeg(`ffmpeg -f concat -safe 0 -i "${listaPath}" -c copy "${concatPath}" -y`);

    const videoFinalPath = path.join(pasta, "short_final.mp4");
    await rodarFFmpeg(
      `ffmpeg -i "${concatPath}" -i "${audioPath}" -t ${duracaoAudio} ` +
      `-map 0:v -map 1:a -c:v libx264 -c:a aac -b:a 192k ` +
      `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
      `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=28:fontcolor=white:alpha=0.6:x=(w-text_w)/2:y=h-60:text='Crime Oculto BR':box=1:boxcolor=black@0.3:boxborderw=8" ` +
      `-preset fast -crf 23 "${videoFinalPath}" -y`
    );

    const videoBuffer = fs.readFileSync(videoFinalPath);
    const tamanhoMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[${jobId}] Short pronto! ${tamanhoMB}MB ${duracaoAudio}s`);

    setTimeout(() => { try { fs.rmSync(pasta, { recursive: true }); } catch (e) {} }, 120000);

    res.json({
      sucesso: true,
      jobId,
      tamanhoMB,
      duracaoSegundos: Math.round(duracaoAudio),
      clipesGerados: clipPaths.length,
      roteiro: textoRoteiro,
      videoBase64: videoBuffer.toString("base64"),
      mensagem: `Short de ${Math.round(duracaoAudio)}s gerado com ${clipPaths.length} clipes!`
    });

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    res.status(500).json({ erro: erro.message, jobId });
  }
});

app.listen(PORT, () => console.log(`🚀 AutoPiloto API v3 - True Crime Shorts - porta ${PORT}`));
