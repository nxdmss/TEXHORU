// Actual production image + Caddy TLS + persistent data. No Yandex account or 1C required.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import https from 'node:https'

const name = 'texhoru-smoke-' + randomUUID().slice(0, 8)
const directory = mkdtempSync(join(tmpdir(), name))
const image = process.env.TEXHORU_TEST_IMAGE || 'texhoru:cloud-test'
const env = { ...process.env }
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key]
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 })
const app = name + '-app', proxy = name + '-caddy'
const email = 'cloud-test@example.org', password = randomUUID(), apiKey = randomUUID() + randomUUID()
const jwt = randomUUID() + randomUUID()
let cookie = '', agent, base
const delay = ms => new Promise(done => setTimeout(done, ms))
function writeEnv(adminPassword) {
  writeFileSync(join(directory, 'app.env'), Object.entries({ NODE_ENV: 'production', DATABASE_URL: 'file:/data/texhoru.db',
    JWT_SECRET: jwt, ONE_C_API_KEY: apiKey, ADMIN_EMAIL: email, ADMIN_PASSWORD: adminPassword,
    SERVE_STOREFRONT: 'true', FRONTEND_ORIGIN: 'https://localhost', FRONTEND_PUBLIC_URL: 'https://localhost',
    MEDIA_STORAGE_DRIVER: 'local', ALLOW_PERSISTENT_LOCAL_MEDIA: 'true', TEXHORU_UPLOADS_DIR: '/uploads',
    HOST: '0.0.0.0', PORT: '3000', TRUST_PROXY_HOPS: '1', SQLITE_WAL_ENABLED: 'true',
    ONE_C_BASE_KIND: 'TEST', ONE_C_TEST_PRICE_SYNC_ENABLED: 'true', MONITOR_WORKER_DISABLED: 'true',
    DATA_RETENTION_ENABLED: 'true', TEXHORU_ENV_FILE: '/nonexistent', ALLOW_DEV_PAYMENT: 'false',
  }).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 })
}
function runApp() {
  docker('run', '-d', '--name', app, '--network', name, '--network-alias', 'app', '--init', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=2560m', '--pids-limit=512',
    '--tmpfs', '/tmp:rw,size=536870912,mode=1777', '--shm-size=256m',
    '--env-file', join(directory, 'app.env'), '-p', '127.0.0.1::3000',
    '--mount', 'type=bind,src=' + join(directory, 'database') + ',dst=/data',
    '--mount', 'type=bind,src=' + join(directory, 'uploads') + ',dst=/uploads', image)
}
async function waitApp() {
  for (let i = 0; i < 90; i++) {
    const state = docker('inspect', '--format', '{{.State.Status}}', app).trim()
    if (state === 'exited') throw Error('Application exited: ' + docker('logs', '--tail', '30', app))
    try {
      const port = docker('port', app, '3000/tcp').trim().split(':').at(-1)
      const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return
    } catch {}
    await delay(500)
  }
  throw Error('Application did not become healthy: ' + docker('logs', '--tail', '30', app))
}
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return new Promise((done, fail) => {
    const req = https.request(base + path, { agent, method, headers: { ...(cookie ? { cookie } : {}),
      ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => {
        const data = Buffer.concat(chunks)
        done({ status: res.statusCode, headers: res.headers, bytes: data, json: () => JSON.parse(data.toString()) })
      })
    })
    req.on('error', fail); req.setTimeout(10000, () => req.destroy(Error('HTTPS request timed out')))
    req.end(bytes)
  })
}
try {
  for (const folder of ['database', 'uploads', 'caddy-data', 'caddy-config']) {
    mkdirSync(join(directory, folder)); chmodSync(join(directory, folder), 0o777)
  }
  writeEnv(password)
  const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'deploy/cloud/compose.yaml', 'config', '--format=json'], {
    env: { ...env, TEXHORU_DOMAIN: 'localhost', TEXHORU_ENV_FILE: join(directory, 'app.env'), TEXHORU_DATA_DIR: directory }, encoding: 'utf8',
  }))
  assert.equal(config.services.app.ports, undefined, 'production API must not expose a host port')
  assert.equal(config.services.app.read_only, true)
  assert.equal(config.services.app.environment.MONITOR_RECHECK_CONCURRENCY, '2')
  assert.equal(config.services.app.logging.options['max-size'], '10m')
  copyFileSync(resolve('deploy/cloud/Caddyfile'), join(directory, 'Caddyfile'))
  chmodSync(join(directory, 'Caddyfile'), 0o644)
  docker('network', 'create', name)
  runApp(); await waitApp()
  docker('run', '-d', '--name', proxy, '--network', name, '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE',
    '--security-opt=no-new-privileges:true', '--tmpfs', '/tmp', '-e', 'TEXHORU_DOMAIN=localhost',
    '-e', 'NO_PROXY=app,localhost,127.0.0.1', '-e', 'no_proxy=app,localhost,127.0.0.1', '-p', '127.0.0.1::443',
    '--mount', 'type=bind,src=' + join(directory, 'Caddyfile') + ',dst=/etc/caddy/Caddyfile,readonly',
    '--mount', 'type=bind,src=' + join(directory, 'caddy-data') + ',dst=/data',
    '--mount', 'type=bind,src=' + join(directory, 'caddy-config') + ',dst=/config', 'caddy:2.10.2-alpine')
  const port = docker('port', proxy, '443/tcp').trim().split(':').at(-1)
  base = 'https://localhost:' + port
  let connected = false
  for (let i = 0; i < 40; i++) {
    try {
      const ca = docker('exec', proxy, 'cat', '/data/caddy/pki/authorities/local/root.crt')
      agent = new https.Agent({ ca })
      if ((await request('/api/health')).status === 200) { connected = true; break }
    } catch {}
    await delay(500)
  }
  assert(connected, 'Caddy HTTPS must work with verification of its local test CA')
  assert.match((await request('/admin')).bytes.toString(), /id="root"/)
  const favicon = await request('/favicon.svg')
  assert.equal(favicon.status, 200, 'runtime user must be able to read public assets')
  assert.match(favicon.bytes.toString(), /<svg/)
  assert.equal((await request('/api/admin/price-monitor/price-readiness')).status, 401)
  let login = await request('/api/auth/login', { method: 'POST', body: { email, password } })
  assert.equal(login.status, 201)
  const setCookie = login.headers['set-cookie'][0]
  assert.match(setCookie, /Secure/); assert.match(setCookie, /HttpOnly/)
  cookie = setCookie.split(';')[0]
  assert.equal((await request('/api/auth/me')).status, 200)
  assert.equal((await request('/api/products')).json().length, 0, 'cloud boot must not seed demo products')
  assert.equal((await request('/api/integrations/1c/price-sync/pending', { headers: { 'x-1c-key': 'incorrect' } })).status, 401)
  const headers = { 'x-1c-key': apiKey }
  const id = randomUUID()
  const catalog = { categories: [{ oneCId: id, slug: 'cloud-test', name: 'Cloud test' }], products: [{
    oneCId: randomUUID(), categoryOneCId: id, sku: 'CLOUD', slug: 'cloud-product', brand: 'Apple', name: 'Cloud test product', price: 1000, stockQty: 1,
  }] }
  assert.equal((await request('/api/integrations/1c/catalog', { method: 'POST', headers, body: catalog })).status, 201)
  assert.equal((await request('/api/integrations/1c/price-sync/pending', { headers })).status, 200)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1UAAAAASUVORK5CYII=', 'base64')
  const boundary = 'TEXHORU' + randomUUID()
  const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const uploaded = await request('/api/admin/uploads/product-image', { method: 'POST', body: multipart, headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } })
  assert.equal(uploaded.status, 201)
  const url = uploaded.json().url
  assert.deepEqual((await request(url)).bytes, png)
  docker('exec', app, 'node', '-e', "const {existsSync}=require('node:fs');const {chromium}=require('playwright');const {FiveRuParser}=require('./dist/price-monitor/five-ru.parser');(async()=>{if(existsSync(chromium.executablePath()))throw Error('Expected a headless-shell-only cloud image');const parser=new FiveRuParser();const b=await parser.browser();const p=await b.newPage();await p.setContent('<h1>TEXHORU</h1>');if(await p.textContent('h1')!=='TEXHORU')throw Error('parser browser');await b.close()})().catch(error=>{console.error(error);process.exit(1)})")
  docker('stop', '--time', '40', app); docker('rm', app)
  const different = randomUUID()
  writeEnv(different); runApp(); await waitApp()
  assert.equal((await request('/api/auth/me')).status, 200, 'session signing key survives replacement')
  assert.equal((await request('/api/products')).json().length, 1, 'catalog survives replacement')
  assert.deepEqual((await request(url)).bytes, png, 'upload survives replacement')
  login = await request('/api/auth/login', { method: 'POST', body: { email, password } })
  assert.equal(login.status, 201, 'existing administrator password is never reset at startup')
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email, password: different } })).status, 401)
  const changedPassword = randomUUID()
  execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', app, 'node', '-e', readFileSync('deploy/cloud/set-admin-password.cjs', 'utf8')], {
    env, input: email + '\0' + changedPassword, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  })
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email, password: changedPassword } })).status, 201, 'operator command must work in an existing image without a rebuild')
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email, password } })).status, 401)
  // Run the host-supplied catalog helper in the existing non-root production image.
  // Use separate /tmp target data; the running site's database is read-only here.
  docker('exec', app, 'node', '-e', readFileSync('deploy/cloud/catalog-transfer.cjs', 'utf8') + `
    ;(async()=>{
      const assert=require('node:assert/strict');
      const {spawnSync}=require('node:child_process');
      const {PrismaClient}=require('@prisma/client');
      const folder='/tmp/catalog-smoke'; fs.mkdirSync(folder,{recursive:true});
      const source=new DatabaseSync('/data/texhoru.db',{readOnly:true});
      const payload=exportCatalogRows(source);source.close();
      fs.writeFileSync(folder+'/catalog.json',JSON.stringify(payload));
      fs.writeFileSync(folder+'/manifest.json',JSON.stringify({format:payload.format,sha256:sha256(folder+'/catalog.json')}));
      fs.cpSync('/uploads',folder+'/uploads',{recursive:true});
      const file='/tmp/catalog-target.db';
      const push=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'db','push','--schema=/app/server/prisma/schema.local.prisma','--skip-generate'],{env:{...process.env,DATABASE_URL:'file:'+file},encoding:'utf8'});
      if(push.status!==0)throw Error(push.stdout+push.stderr);
      const target=new PrismaClient({datasources:{db:{url:'file:'+file}}});
      await target.user.create({data:{email:'preserved@example.org',name:'Preserved',role:'DIRECTOR',passwordHash:'cloud-password-unchanged'}});
      await target.$disconnect();
      const result=importCatalog(folder,file,'/tmp/catalog-target-uploads');
      assert.equal(result.products,1);
      const check=new DatabaseSync(file,{readOnly:true});
      assert.equal(check.prepare('SELECT passwordHash FROM User').get().passwordHash,'cloud-password-unchanged');
      assert.equal(check.prepare('SELECT COUNT(*) n FROM OneCPriceChange').get().n,0);check.close();
    })().catch(e=>{console.error(e.message);process.exitCode=1})
  `)
  console.log('PASS: production image, verified Caddy TLS, secure login, 1C API authentication/import, persistent catalog/uploads, non-resetting admin and Chromium. No live 1C or 05.ru exercised.')
} finally {
  agent?.destroy()
  for (const container of [proxy, app]) try { docker('rm', '-f', container) } catch {}
  try { docker('network', 'rm', name) } catch {}
  // Caddy's private CA files are root-owned. Remove only this test's temp tree.
  try { docker('run', '--rm', '--user=0', '--entrypoint=sh', '--mount', 'type=bind,src=' + directory + ',dst=/smoke', image, '-c', 'rm -rf /smoke/*') } catch {}
  rmSync(directory, { recursive: true, force: true })
}
