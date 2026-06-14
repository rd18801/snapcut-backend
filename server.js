const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

try {
  const WebSocket = require('ws');
  if (!globalThis.WebSocket) {
    globalThis.WebSocket = WebSocket;
  }
} catch (e) {
  console.warn('ws package not found. If Supabase fails, install ws.');
}

try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
  }
} catch (e) {
  console.log('ffmpeg-static not found. Using system ffmpeg.');
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'clips';

if (!SUPABASE_URL) {
  console.warn('Missing environment variable: SUPABASE_URL');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const TMP_ROOT = path.join(os.tmpdir(), 'snapcut');
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const OUTPUT_DIR = path.join(TMP_ROOT, 'outputs');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function getExt(filename, fallback = '.mp4') {
  const ext = path.extname(filename || '').toLowerCase();
  return ext || fallback;
}

async function cleanup(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fsp.rm(p, { recursive: true, force: true });
    } catch (e) {
      console.warn('Cleanup failed:', p, e.message);
    }
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = getExt(file.originalname);
    cb(null, `${Date.now()}-${newId()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();

  if (listError) {
    throw new Error(`Cannot list Supabase buckets: ${listError.message}`);
  }

  const exists = Array.isArray(buckets) && buckets.some((b) => b.name === SUPABASE_BUCKET);

  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(SUPABASE_BUCKET, {
      public: true,
    });

    if (createError) {
      throw new Error(`Cannot create bucket "${SUPABASE_BUCKET}": ${createError.message}`);
    }
  }
}

async function uploadToSupabase(localPath, storagePath, contentType = 'video/mp4') {
  const fileBuffer = await fsp.readFile(localPath);

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase upload failed for ${storagePath}: ${error.message}`);
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

  if (!signedError && signedData && signedData.signedUrl) {
    return signedData.signedUrl;
  }

  const { data: publicData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(storagePath);

  return publicData.publicUrl;
}

function runFfmpegSplit(inputPath, outputPattern, clipDuration) {
  return new Promise((resolve, reject) => {
    const ffmpegLogs = [];

    ffmpeg(inputPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 0:a?',
        '-c:v libx264',
        '-preset veryfast',
        '-crf 28',
        '-pix_fmt yuv420p',
        '-vf scale=trunc(min(iw\\,720)/2)*2:trunc(-2/2)*2',
        '-c:a aac',
        '-b:a 96k',
        `-force_key_frames expr:gte(t,n_forced*${clipDuration})`,
        '-f segment',
        `-segment_time ${clipDuration}`,
        '-segment_format mp4',
        '-reset_timestamps 1',
        '-avoid_negative_ts make_zero',
      ])
      .output(outputPattern)
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('stderr', (line) => {
        ffmpegLogs.push(line);
        console.log('FFmpeg stderr:', line);
      })
      .on('end', () => {
        console.log('FFmpeg split completed');
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
        console.error('FFmpeg full logs:', ffmpegLogs.join('\n'));
        reject(new Error(`FFmpeg failed: ${err.message}`));
      })
      .run();
  });
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'SnapCut backend is running',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'snapcut-backend',
  });
});

app.post('/split-video', upload.single('video'), async (req, res) => {
  const jobId = newId();
  const jobOutputDir = path.join(OUTPUT_DIR, jobId);

  let inputPath = null;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Supabase environment variables are missing.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file received. Make sure FlutterFlow sends the file field as "video".',
      });
    }

    inputPath = req.file.path;

    const clipDuration = parseInt(req.body.clipDuration || '10', 10);

    if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid clipDuration. Use 10, 15, 30, or 60.',
      });
    }

    await ensureBucket();
    await fsp.mkdir(jobOutputDir, { recursive: true });

    console.log('New split job:', {
      jobId,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      clipDuration,
    });

    const { error: jobInsertError } = await supabase.from('video_jobs').insert({
      id: jobId,
      original_video_url: null,
      clip_duration: clipDuration,
      status: 'processing',
    });

    if (jobInsertError) {
      throw new Error(`Failed to create video job row: ${jobInsertError.message}`);
    }

    const outputPattern = path.join(jobOutputDir, `clip_%03d.mp4`);

    await runFfmpegSplit(inputPath, outputPattern, clipDuration);

    const files = (await fsp.readdir(jobOutputDir))
      .filter((file) => file.toLowerCase().endsWith('.mp4'))
      .sort();

    if (!files.length) {
      throw new Error('FFmpeg finished but no clips were created.');
    }

    const clips = [];

    for (let index = 0; index < files.length; index++) {
      const fileName = files[index];
      const clipNumber = index + 1;
      const clipName = `${String(clipNumber).padStart(3, '0')}.mp4`;

      const localClipPath = path.join(jobOutputDir, fileName);
      const storagePath = `clips/${jobId}/${clipName}`;

      const clipUrl = await uploadToSupabase(localClipPath, storagePath, 'video/mp4');

      clips.push({
        clip_number: clipNumber,
        clip_name: clipName,
        clip_url: clipUrl,
      });
    }

    const clipRows = clips.map((clip) => ({
      job_id: jobId,
      clip_number: clip.clip_number,
      clip_name: clip.clip_name,
      clip_url: clip.clip_url,
    }));

    const { error: clipsInsertError } = await supabase
      .from('video_clips')
      .insert(clipRows);

    if (clipsInsertError) {
      throw new Error(`Failed to insert video clips rows: ${clipsInsertError.message}`);
    }

    const { error: jobUpdateError } = await supabase
      .from('video_jobs')
      .update({ status: 'completed' })
      .eq('id', jobId);

    if (jobUpdateError) {
      console.warn('Failed to update job status:', jobUpdateError.message);
    }

    return res.json({
      success: true,
      jobId,
      clipDuration,
      originalVideoUrl: null,
      clipsCount: clips.length,
      clips,
    });
  } catch (error) {
    console.error('Split video request failed:', error.message);

    try {
      await supabase
        .from('video_jobs')
        .update({ status: 'failed' })
        .eq('id', jobId);
    } catch (e) {
      console.warn('Failed to mark job as failed:', e.message);
    }

    return res.status(500).json({
      success: false,
      jobId,
      error: error.message,
    });
  } finally {
    await cleanup([inputPath, jobOutputDir]);
  }
});

app.listen(PORT, () => {
  console.log(`SnapCut backend running on port ${PORT}`);
});
