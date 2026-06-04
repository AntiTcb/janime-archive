import { unpack } from "7zip-min";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const ARCHIVE_DIR = path.join(ROOT, "archive");

const DROPBOX_URLS = [
  "https://www.dropbox.com/s/sra430u110gijg4/Janime%20Wiki.7z?dl=0",
  "https://www.dropbox.com/s/r1b5mzspykcboyh/Gen%20Disc%20(1).7z?dl=0",
  "https://www.dropbox.com/s/avw6wm5izy96x83/Gen%20Disc%20(2).7z?dl=0",
  "https://www.dropbox.com/s/tj3ns3uo11kvjzf/Bonds%20Beyond%20Time.7z?dl=0",
  "https://www.dropbox.com/s/uohtylvovcgti2d/Debating%20Hall.7z?dl=0",
  "https://www.dropbox.com/s/6yodqi74j5eefq1/DM.7z?dl=0",
  "https://www.dropbox.com/s/3grxm4q4h4oe9b0/GX.7z?dl=0",
  "https://www.dropbox.com/s/xdb2ecetncpuaxu/5Ds.7z?dl=0",
  "https://www.dropbox.com/s/dup2004xnf8e2us/Manga.7z?dl=0",
  "https://www.dropbox.com/s/0n8iqjdk0x4e6bp/Poet's%20Alchemy%20Stuff.7z?dl=0",
];

/**
 * @param {string} url
 */
const toDirectDownload = (url) => url.replace(/([?&])dl=0\b/, "$1dl=1");

/**
 * @param {string} url
 */
const fileNameFromUrl = (url) => {
  const pathname = new URL(url).pathname;
  return decodeURIComponent(pathname.split("/").pop() ?? "");
};

/**
 * @param {number} bytes
 */
const formatSize = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * @param {string} url
 * @param {string} destPath
 */
const download = async (url, destPath) => {
  const res = await fetch(toDirectDownload(url), { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(
      `Download failed (${res.status} ${res.statusText}) for ${url}`,
    );
  }
  const tmpPath = `${destPath}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, destPath);
  return fs.statSync(destPath).size;
};

const main = async () => {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  for (const [index, url] of DROPBOX_URLS.entries()) {
    const fileName = fileNameFromUrl(url);
    const archivePath = path.join(DOWNLOAD_DIR, fileName);
    const counter = `[${index + 1}/${DROPBOX_URLS.length}]`;

    if (fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0) {
      console.log(
        `${counter} Skipping download (already present): ${fileName}`,
      );
    } else {
      console.log(`${counter} Downloading ${fileName} ...`);
      const size = await download(url, archivePath);
      console.log(`${counter} Downloaded ${fileName} (${formatSize(size)})`);
    }

    console.log(
      `${counter} Extracting ${fileName} -> ${path.relative(ROOT, ARCHIVE_DIR)}/`,
    );
    await unpack(archivePath, ARCHIVE_DIR);
    console.log(`${counter} Extracted ${fileName}`);
  }

  console.log(
    `\nDone. ${DROPBOX_URLS.length} archives extracted to ${ARCHIVE_DIR}`,
  );
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
