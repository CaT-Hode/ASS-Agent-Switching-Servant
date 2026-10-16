const zlib = require("node:zlib");
const { promisify } = require("node:util");
const LIMIT = 128 * 1024 * 1024;
const decoders = { gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress, zstd: zlib.zstdDecompress };

async function readBytes(req, limit = LIMIT) {
  const encoding = String(req.headers["content-encoding"] || "identity").trim().toLowerCase();
  if (encoding !== "identity" && typeof decoders[encoding] !== "function")
    throw Object.assign(Error("不支持的请求压缩格式"), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error("请求体超过大小限制"), { status: 413 });
    chunks.push(chunk);
  }
  let bytes = Buffer.concat(chunks);
  if (encoding !== "identity") {
    try { bytes = await promisify(decoders[encoding])(bytes, { maxOutputLength: limit }); }
    catch (error) {
      throw Object.assign(Error(error.code === "ERR_BUFFER_TOO_LARGE" ? "解压后的请求体超过大小限制" : "请求体解压失败"),
        { status: error.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400 });
    }
  }
  return bytes;
}
async function readJSON(req, limit = LIMIT) {
  const bytes = await readBytes(req, limit);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw Object.assign(Error("请求不是有效 JSON"), { status: 400 }); }
}
module.exports = { readJSON, readBytes };
