const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const crypto = require("crypto");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: WebSocket
    }
  }
);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "SnapCut backend is running"
  });
});

app.post("/split-video", upload.single("video"), async (req, res) => {
  try {
    const clipDuration = parseInt(req.body.clipDuration || "60", 10);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No video file uploaded"
      });
    }

    const jobId = crypto.randomUUID();
    const inputPath = req.file.path;
    const outputDir = path.join(__dirname, "output", jobId);

    fs.mkdirSync(outputDir, { recursive: true });

    const outputPattern = path.join(outputDir, "clip_%03d.mp4");

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-c copy",
          "-map 0",
          "-segment_time " + clipDuration,
          "-f segment",
          "-reset_timestamps 1"
        ])
        .output(outputPattern)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const files = fs
      .readdirSync(outputDir)
      .filter((file) => file.endsWith(".mp4"))
      .sort();

    const clips = [];

    for (let i = 0; i < files.length; i++) {
      const fileName = files[i];
      const filePath = path.join(outputDir, fileName);
      const storagePath = `${jobId}/${fileName}`;
      const fileBuffer = fs.readFileSync(filePath);

      const { error: uploadError } = await supabase.storage
        .from("processed-clips")
        .upload(storagePath, fileBuffer, {
          contentType: "video/mp4",
          upsert: true
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from("processed-clips")
        .getPublicUrl(storagePath);

      clips.push({
        clip_number: i + 1,
        clip_name: fileName,
        clip_url: publicUrlData.publicUrl
      });
    }

    fs.rmSync(inputPath, { force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      clipDuration,
      clips
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SnapCut backend running on port ${PORT}`);
});
