import { decodeCid, encodeCid } from "@lumeweb/libportal";
import {
  BOOTSTRAP_NODES,
  CID_HASH_TYPES,
  CID_TYPES,
  createKeyPair,
  createNode,
  REGISTRY_TYPES,
  S5NodeConfig,
} from "@lumeweb/libs5";
import KeyPairEd25519 from "@lumeweb/libs5/lib/ed25519.js";
import fs from "fs/promises";
import { MemoryLevel } from "memory-level";
import { base58btc } from "multiformats/bases/base58";
import path from "path";
import * as process from "process";
import fromAsync from "array-from-async";
import * as util from "util";

import {
  CID,
  concatBytes,
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
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "ed25519-keygen/hdkey";
import defer from "p-defer";

import type { WebAppMetadata } from "#types.js";

const BIP44_PATH = "m/44'/1627'/0'/0'/0'";

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

let seed = process.env.APP_SEED;
if (!seed && seed === undefined) {
  // @ts-ignore
  seed = await prompts.prompts.password({
    name: "module_seed",
    message: "Enter your app seed",
    validate: (prev) => prev && bip39.validateMnemonic(prev, wordlist),
  });
}

const hdKey = seed
  ? HDKey.fromMasterSeed(await bip39.mnemonicToSeed(seed as string)).derive(
      BIP44_PATH,
    )
  : false;

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

let [cid, err] = await uploadObject(serializedMetadata);
if (err) {
  console.error("Failed to publish: ", err);
  process.exit(1);
}

cid = decodeCid(cid) as CID;
cid = encodeCid(cid.hash, cid.size, CID_TYPES.METADATA_WEBAPP);

console.log(
  util.format("%s: %s", chalk.green("Web App successfully published"), cid),
);

if (!hdKey) {
  process.exit(0);
}

const db = new MemoryLevel<string, Uint8Array>({
  storeEncoding: "view",
  valueEncoding: "buffer",
});
await db.open();

let config = {
  keyPair: createKeyPair(),
  db,
  p2p: {
    peers: {
      initial: [...BOOTSTRAP_NODES],
    },
  },
  logger: {
    info: (s: string) => {},
    verbose: (s: string) => {},
    warn: (s: string) => {},
    error: (s: string) => {},
    catched: (e: any, context?: string | null) => {},
  },
} as S5NodeConfig;

const node = createNode(config);
await node.start();

const peerDefer = defer();

node.services.p2p.once("peerConnected", peerDefer.resolve);

await peerDefer.promise;
{
  const cidBytes = base58btc.decode(cid);
  const key = hdKey as HDKey;

  let revision = 0;

  const ret = await node.services.registry.get(
    new KeyPairEd25519(key.privateKey).publicKey,
  );

  if (ret) {
    revision = ret.revision + 1;
  }
  const sre = node.services.registry.signRegistryEntry({
    kp: new KeyPairEd25519((hdKey as HDKey).privateKey),
    data: concatBytes(
      Uint8Array.from([
        REGISTRY_TYPES.CID,
        CID_TYPES.RESOLVER,
        CID_HASH_TYPES.BLAKE3,
      ]),
      cidBytes,
    ),
    revision,
  });

  await node.services.registry.set(sre);

  console.log(
    util.format(
      "%s: %s",
      chalk.green("Resolver entry"),
      encodeCid(cidBytes, 0, CID_TYPES.RESOLVER, CID_HASH_TYPES.ED25519),
    ),
  );
  await node.stop();
}

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
