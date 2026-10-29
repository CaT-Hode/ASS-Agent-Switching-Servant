// Synthetic ASAR framing shared by desktop metadata and launcher tests.
function archiveBuffer(header, data = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = 4 + Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(4 + payloadSize);
  headerPickle.writeUInt32LE(payloadSize, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, data]);
}
module.exports = { archiveBuffer };
