import fs from "fs/promises";
import path from "path";
import * as process from "process";
import fromAsync from "array-from-async";

import * as util from "util";

import {
  hexToBytes,
  loginActivePortals,
  maybeInitDefaultPortals,
  setActivePortalMasterKey,
  uploadObject,
} from "@lumeweb/libweb";

import chalk from "chalk";

import mime from "mime";
import { pack } from "msgpackr";
import PQueue from "p-queue";
import prompts from "prompts";

import type { WebAppMetadata } from "#types.js";

let key = process.env.PORTAL_PRIVATE_KEY;
let dir = process.env.DIR;
const parallelUploads = parseInt(process.env.PARALLEL_UPLOADS ?? "0", 10) || 10;

if (!key) {
  key = await prompts.prompts.password({
    name: "private_key",
    message: "Enter your private key",
    validate: (prev: string) => prev && prev.length === 64,
    type: undefined,
  });
}

if (!dir) {
  dir = (await prompts.prompts.text({
    name: "dir",
    message: "Enter the directory of the webapp",
    validate: (prev: string) => prev && prev.length > 0,
    type: undefined,
  })) as unknown as string;
}

dir = path.resolve(dir) + "/";

setActivePortalMasterKey(hexToBytes(key as string));
maybeInitDefaultPortals();

const processedFiles: Array<{ cid: string; file: string; size: number }> = [];
const queue = new PQueue({ concurrency: parallelUploads });

void (await loginActivePortals());

const files: string[] = await fromAsync(walkSync(dir));

files.forEach((item) => {
  void queue.add(async () => processFile(item));
});

await queue.onIdle();

const metadata: WebAppMetadata = {
  type: "web_app",
  paths: {},
  tryFiles: ["index.html"],
};

processedFiles
  .sort((a, b) => {
    if (a.file < b.file) {
      return -1;
    }
    if (a.file > b.file) {
      return 1;
    }

    return 0;
  })
  .forEach((item) => {
    metadata.paths[item.file] = {
      cid: item.cid,
      contentType: mime.getType(item.file) ?? "application/octet-stream",
      size: item.size,
    };
  });

const serializedMetadata = pack(metadata);

const [cid, err] = await uploadObject(serializedMetadata);
if (err) {
  console.error("Failed to publish: ", err);
  process.exit(1);
}

console.log(
  util.format("%s: %s", chalk.green("Web App successfully published"), cid),
);

async function processFile(filePath: string) {
  const fd = await fs.open(filePath);
  const size = (await fd.stat()).size;
  const [cid, err] = await uploadObject(fd.createReadStream(), BigInt(size));
  if (err) {
    console.error("Failed to publish: ", err);
    process.exit(1);
  }
  processedFiles.push({ cid, file: filePath.replace(dir as string, ""), size });
}

async function* walkSync(dir: string): AsyncGenerator<string> {
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    if (file.isDirectory()) {
      yield* walkSync(path.join(dir, file.name));
    } else {
      yield path.join(dir, file.name);
    }
  }
}
