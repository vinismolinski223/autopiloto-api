const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = "1gVxvfFtEYlCHzbTBogIzc_rKsKSHm0dg";
const TMP = "/tmp/autopiloto";

// Garante pasta temp
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ─── Health check ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "AutoPiloto API rodando!", version: "1.0.0" });
});

// ─── Utilitários ─────────────────────────────────────────────
function baixarArquivo(url, destino) {
  return new Promise(async (resolve, reject) => {
    const res = await axios({ url, responseType: "arraybuffer" });
    fs.writeFileSync(destino, Buffer.from(res.data));
    resolve(destino);
  });
}

function rodarFFmpeg(comando) {
  return new Promise((resolve, reject) => {
    exec(comando, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function uploadDrive(caminhoArquivo, nomeArquivo) {
  // Upload simples via Google Drive API com service account ou API key publica
  // Aqui usamos uma abordagem de upload multipart simplificada
  const fileContent = fs.readFileSync(caminhoArquivo);
  const base64 = fileContent.toString("base64");
  
  // Salva numa pasta publica e retorna link direto
  // Para producao real, use service account JSON
  const driveUrl = `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`;
  return { driveUrl, base64 };
}

// ─── ROTA PRINCIPAL: Montar vídeo ────────────────────────────
app.post("/montar-video", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const pasta = path.join(TMP, jobId);
  fs.mkdirSync(pasta, { recursive: true });

  console.log(`[${jobId}] Iniciando montagem...`);

  try {
    const { audioUrl, clipUrls, titulo } = req.body;

    if (!audioUrl || !clipUrls || clipUrls.length === 0) {
      return res.status(400).json({ erro: "audioUrl e clipUrls são obrigatórios" });
    }

    // 1. Baixar áudio
    console.log(`[${jobId}] Baixando narração...`);
    const audioPath = path.join(pasta, "narracao.mp3");
    await baixarArquivo(audioUrl, audioPath);

    // 2. Baixar clipes de vídeo
    console.log(`[${jobId}] Baixando ${clipUrls.length} clipes...`);
    const clipPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const clipPath = path.join(pasta, `clip_${i}.mp4`);
      await baixarArquivo(clipUrls[i], clipPath);
      clipPaths.push(clipPath);
      console.log(`[${jobId}] Clipe ${i + 1}/${clipUrls.length} baixado`);
    }

    // 3. Criar arquivo de lista de clipes para FFmpeg
    const listaPath = path.join(pasta, "lista.txt");
    const listaConteudo = clipPaths.map(p => `file '${p}'`).join("\n");
    fs.writeFileSync(listaPath, listaConteudo);

    // 4. Concatenar clipes em loop até cobrir o áudio
    console.log(`[${jobId}] Concatenando clipes...`);
    const clipesConcatPath = path.join(pasta, "clipes_concat.mp4");
    
    // Repete os clipes 3x pra garantir que cubra o áudio completo
    const listaLoop = [...clipPaths, ...clipPaths, ...clipPaths]
      .map(p => `file '${p}'`).join("\n");
    const listaLoopPath = path.join(pasta, "lista_loop.txt");
    fs.writeFileSync(listaLoopPath, listaLoop);

    await rodarFFmpeg(
      `ffmpeg -f concat -safe 0 -i "${listaLoopPath}" -c copy "${clipesConcatPath}" -y`
    );

    // 5. Obter duração do áudio
    const duracaoAudio = await new Promise((resolve) => {
      exec(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
        (err, stdout) => resolve(parseFloat(stdout.trim()) || 300)
      );
    });
    console.log(`[${jobId}] Duração do áudio: ${duracaoAudio}s`);

    // 6. Montar vídeo final: clipes + narração + legenda simples
    console.log(`[${jobId}] Montando vídeo final...`);
    const videoFinalPath = path.join(pasta, "autopiloto_final.mp4");
    const nomeCanal = "AutoPiloto";

    await rodarFFmpeg(
      `ffmpeg -i "${clipesConcatPath}" -i "${audioPath}" ` +
      `-t ${duracaoAudio} ` +
      `-map 0:v -map 1:a ` +
      `-c:v libx264 -c:a aac -b:a 192k ` +
      `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,` +
      `drawtext=fontsize=36:fontcolor=white:alpha=0.8:x=(w-text_w)/2:y=h-80:` +
      `text='${nomeCanal}':box=1:boxcolor=black@0.5:boxborderw=10" ` +
      `-preset fast -crf 23 ` +
      `"${videoFinalPath}" -y`
    );

    console.log(`[${jobId}] Vídeo montado com sucesso!`);

    // 7. Ler vídeo e retornar como base64 + link Drive
    const videoBuffer = fs.readFileSync(videoFinalPath);
    const videoBase64 = videoBuffer.toString("base64");
    const tamanhoMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

    // 8. Limpar arquivos temporários
    setTimeout(() => {
      try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    }, 60000);

    console.log(`[${jobId}] Concluído! Tamanho: ${tamanhoMB}MB`);

    res.json({
      sucesso: true,
      jobId,
      tamanhoMB,
      duracaoSegundos: Math.round(duracaoAudio),
      videoBase64,
      driveUrl: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
      mensagem: `Vídeo de ${Math.round(duracaoAudio)}s montado com sucesso!`
    });

  } catch (erro) {
    console.error(`[${jobId}] Erro:`, erro.message);
    try { fs.rmSync(pasta, { recursive: true }); } catch (e) {}
    res.status(500).json({ erro: erro.message, jobId });
  }
});

// ─── ROTA: Status ────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    tmpDir: TMP,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 AutoPiloto API rodando na porta ${PORT}`);
});
