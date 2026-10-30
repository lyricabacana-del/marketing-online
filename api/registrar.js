// Función de Vercel: recibe el formulario y lo guarda en un JSON dentro de un repo PRIVADO de GitHub.
// Variables de entorno (se configuran en Vercel, nunca en el código):
//   GITHUB_TOKEN  -> token fine-grained con permiso "Contents: Read and write" solo sobre el repo de datos
//   GITHUB_OWNER  -> tu usuario de GitHub
//   GITHUB_REPO   -> nombre del repo privado de datos
//   DATA_PATH     -> (opcional) archivo, por defecto registros.json
//   GITHUB_BRANCH -> (opcional) rama, por defecto main

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const FILE = process.env.DATA_PATH || "registros.json";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const MAX_BYTES = 900 * 1024; // la API de contenidos de GitHub lee hasta ~1 MB

const EXPERIENCIA = ["No, empiezo de cero", "Un poco", "Sí, bastante"];
const TIEMPO = ["Menos de 1 hora", "1 a 2 horas", "Más de 2 horas"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (v, max) =>
  String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function ghUrl() {
  const p = FILE.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}/contents/${p}`;
}
function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "landing-registro",
    "Content-Type": "application/json",
  };
}

async function tryAppend(reg) {
  let list = [];
  let sha;

  const get = await fetch(`${ghUrl()}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders() });
  if (get.status === 200) {
    const j = await get.json();
    sha = j.sha;
    const text = Buffer.from(j.content || "", "base64").toString("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) {
      return { error: "La base de registros está llena. Avisa al administrador.", status: 507 };
    }
    try {
      list = text.trim() ? JSON.parse(text) : [];
    } catch (e) {
      return { error: "El archivo de datos está dañado.", status: 500 };
    }
    if (!Array.isArray(list)) return { error: "El archivo de datos tiene un formato inválido.", status: 500 };
  } else if (get.status !== 404) {
    return { error: "No se pudo leer la base de datos.", status: 502 };
  }

  // Evita duplicados por WhatsApp
  if (list.some((x) => x && x.whatsapp === reg.whatsapp)) return { ok: true };

  list.push(reg);
  const put = await fetch(ghUrl(), {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify({
      message: `registro ${reg.id}`,
      content: Buffer.from(JSON.stringify(list, null, 2), "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (put.status === 200 || put.status === 201) return { ok: true };
  if (put.status === 409 || put.status === 422) return { conflict: true }; // otro registro se guardó a la vez
  return { error: "No se pudo guardar el registro.", status: 502 };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }
  if (!TOKEN || !OWNER || !REPO) {
    return res.status(500).json({ ok: false, error: "El servidor no está configurado." });
  }

  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  b = b || {};

  // Campo trampa anti-spam: si viene lleno, se ignora en silencio
  if (b.empresa_web) return res.status(200).json({ ok: true });

  const reg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fecha: new Date().toISOString(),
    nombre: clean(b.nombre, 80),
    whatsapp: clean(b.whatsapp, 25).replace(/[^\d+]/g, ""),
    ciudad: clean(b.ciudad, 80),
    correo: clean(b.correo, 120).toLowerCase(),
    experiencia: clean(b.experiencia, 40),
    tiempo: clean(b.tiempo, 40),
    estado: "Nuevo",
    notas: "",
  };

  if (!reg.nombre || !reg.ciudad) return res.status(400).json({ ok: false, error: "Completa todos los campos." });
  if (reg.whatsapp.replace(/\D/g, "").length < 8) return res.status(400).json({ ok: false, error: "Revisa tu número de WhatsApp." });
  if (!/^\S+@\S+\.\S+$/.test(reg.correo)) return res.status(400).json({ ok: false, error: "Revisa tu correo electrónico." });
  if (!EXPERIENCIA.includes(reg.experiencia) || !TIEMPO.includes(reg.tiempo)) {
    return res.status(400).json({ ok: false, error: "Completa todos los campos." });
  }

  try {
    for (let i = 0; i < 4; i++) {
      const r = await tryAppend(reg);
      if (r.ok) return res.status(200).json({ ok: true });
      if (r.conflict) {
        await sleep(300 * (i + 1) + Math.floor(Math.random() * 300));
        continue;
      }
      return res.status(r.status || 500).json({ ok: false, error: r.error });
    }
    return res.status(503).json({ ok: false, error: "Hay muchos registros a la vez. Intenta de nuevo en un momento." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Error inesperado. Intenta de nuevo." });
  }
};
