import fs from "node:fs"
import os from "node:os"
import path from "node:path"
export const tmpdir = (p = "openbot-test-") => fs.mkdtempSync(path.join(os.tmpdir(), p))
