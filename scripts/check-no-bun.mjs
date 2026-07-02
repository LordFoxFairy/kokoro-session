import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const problems = []

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"))
}

function rel(path) {
  return relative(root, path)
}

function collect(dir, out = []) {
  const full = join(root, dir)
  if (!existsSync(full)) return out
  for (const name of readdirSync(full)) {
    const path = join(full, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      collect(rel(path), out)
    } else if (/\.(ts|tsx|js|mjs|md|json|yaml|yml)$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

const packageJson = readJson("package.json")
const bunCommandPattern = /(?:^|[;&|()\s])bun(?:\s|$)/i

for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
  if (bunCommandPattern.test(String(command))) {
    problems.push(`package.json script ${scriptName} still invokes Bun`)
  }
}

for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    if (/bun/i.test(name)) {
      problems.push(`package.json ${section} still depends on ${name}`)
    }
  }
}

const tsconfig = readJson("tsconfig.json")
if ((tsconfig.compilerOptions?.types ?? []).includes("bun")) {
  problems.push("tsconfig.json still includes Bun ambient types")
}

if (existsSync(join(root, "bun.lock"))) {
  problems.push("bun.lock still exists")
}

for (const path of [
  "README.md",
  "pnpm-lock.yaml",
  ...collect("src"),
  ...collect("tests"),
]) {
  const full = join(root, path)
  if (!existsSync(full)) continue
  const text = readFileSync(full, "utf8")
  if (/bun:test|@types\/bun|\bBun\b|\bbun\s+(install|run|test|--watch)/i.test(text)) {
    problems.push(`${path} still mentions Bun`)
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`)
  process.exit(1)
}
