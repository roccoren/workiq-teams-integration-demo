#!/usr/bin/env node
/**
 * 打包 Teams 应用包（zip），不依赖系统的 `zip` 命令。
 *
 * 用法：
 *   node scripts/pack-teams-app.mjs [输出文件]        # 默认 teams/workiq-demo.zip
 *
 * 只打 manifest.json + color.png + outline.png 三个文件，且必须在 zip 根目录 ——
 * Teams 对目录层级很敏感，多一层文件夹就会拒收。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkgDir = process.env.TEAMS_APP_PACKAGE_DIR
  ? path.resolve(process.env.TEAMS_APP_PACKAGE_DIR)
  : path.join(root, "teams", "appPackage");
const outFile = path.resolve(process.argv[2] ?? path.join(root, "teams", "workiq-demo.zip"));
const MEMBERS = ["manifest.json", "color.png", "outline.png"];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS 时间戳固定为 1980-01-01，让同样的输入产出字节一致的包（便于校验/比对）
const DOS_TIME = 0;
const DOS_DATE = 33;

const locals = [];
const central = [];
let offset = 0;

for (const name of MEMBERS) {
  const file = path.join(pkgDir, name);
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺少 ${file}（先跑 generate-icons.mjs / generate-manifest.mjs）`);
    process.exit(2);
  }
  const raw = fs.readFileSync(file);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(raw);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  locals.push(local, body);

  const entry = Buffer.alloc(46 + nameBuf.length);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4); // version made by
  entry.writeUInt16LE(20, 6); // version needed
  entry.writeUInt16LE(0, 8);
  entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(raw.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt16LE(0, 30); // extra
  entry.writeUInt16LE(0, 32); // comment
  entry.writeUInt16LE(0, 34); // disk
  entry.writeUInt16LE(0, 36); // internal attrs
  entry.writeUInt32LE(0, 38); // external attrs
  entry.writeUInt32LE(offset, 42);
  nameBuf.copy(entry, 46);
  central.push(entry);

  offset += local.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(MEMBERS.length, 8);
end.writeUInt16LE(MEMBERS.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...locals, centralBuf, end]));

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "manifest.json"), "utf8"));
console.log(`应用包: ${outFile} (${fs.statSync(outFile).size} bytes)`);
console.log(`  id=${manifest.id} version=${manifest.version} bot=${manifest.bots?.[0]?.botId ?? "-"}`);
console.log(`  tab=${manifest.staticTabs?.[0]?.contentUrl ?? "无"}`);
console.log(`  sso=${manifest.webApplicationInfo?.resource ?? "未启用"}`);
