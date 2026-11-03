// Client isolation checks for reseller mode (access.ts).
//
// Needs a dev server with an EMPTY data folder (first-run state), for example the
// "hostpanel-setup" entry of .claude/launch.json (port 3010):
//   rm -rf .dev-data/setup-test   # then start the server
//   node panel/api/test/isolation.mjs            (HP_TEST_URL=http://localhost:3010 by default)
const BASE = process.env.HP_TEST_URL ?? 'http://localhost:3010';
const PW = 'Kq7#vLm2xR9!tWp4';

function session() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const results = [];
function check(name, cond, detail = '') {
  results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : `  → ${JSON.stringify(detail).slice(0, 200)}`}`);
}

const owner = session();
let r = await owner('GET', '/api/setup/status');
if (!r.data.account) {
  r = await owner('POST', '/api/setup/account', { username: 'titular.ops', email: 'titular@ejemplo-empresa.es', password: PW });
  check('owner account created', r.status === 200, r);
} else {
  r = await owner('POST', '/api/auth/login', { username: 'titular.ops', password: PW });
  check('owner login', r.status === 200, r);
}

const da = (await owner('POST', '/api/domains', { name: 'cliente-a.es' })).data;
const db_ = (await owner('POST', '/api/domains', { name: 'cliente-b.es' })).data;
const dOwn = (await owner('POST', '/api/domains', { name: 'titular.es' })).data;
check('domains created', da.id && db_.id && dOwn.id, [da, db_, dOwn]);

const ca = (await owner('POST', '/api/clients', { name: 'Cliente A', email: 'a@cliente-a.es' })).data;
const cb = (await owner('POST', '/api/clients', { name: 'Cliente B' })).data;
r = await owner('PUT', `/api/clients/${ca.id}/resources`, { domain_ids: [da.id], database_ids: [] });
check('assign A', r.status === 200, r);
r = await owner('PUT', `/api/clients/${cb.id}/resources`, { domain_ids: [db_.id], database_ids: [] });
check('assign B', r.status === 200, r);
r = await owner('PUT', `/api/clients/${cb.id}/resources`, { domain_ids: [db_.id, da.id], database_ids: [] });
check('cannot steal A domain for B', r.status === 400, r);

r = await owner('POST', '/api/users', { username: 'admin', role: 'client', client_id: ca.id });
check('reserved username refused', r.status === 400, r);
const ua = (await owner('POST', '/api/users', { username: 'lucia.a', role: 'client', client_id: ca.id })).data;
const ub = (await owner('POST', '/api/users', { username: 'pedro.b', role: 'client', client_id: cb.id })).data;
check('client users created with generated password', ua.password && ub.password, [ua, ub]);

// Owner creates a site for each client domain.
const siteA = (await owner('POST', '/api/sites', { name: 'web-a', hostnames: ['cliente-a.es'], type: 'static', repo_url: '', branch: 'main' })).data;
const siteB = (await owner('POST', '/api/sites', { name: 'web-b', hostnames: ['cliente-b.es'], type: 'static', repo_url: '', branch: 'main' })).data;
check('sites created', siteA.id && siteB.id, [siteA, siteB]);

const A = session();
r = await A('POST', '/api/auth/login', { username: 'lucia.a', password: ua.password });
check('client A login', r.status === 200, r);
r = await A('GET', '/api/auth/me');
check('me says role client', r.data.role === 'client' && r.data.client?.name === 'Cliente A', r.data);

r = await A('GET', '/api/domains');
check('A sees only its domain', Array.isArray(r.data) && r.data.length === 1 && r.data[0].name === 'cliente-a.es', r.data);
r = await A('GET', '/api/sites');
check('A sees only its site', Array.isArray(r.data) && r.data.length === 1 && r.data[0].name === 'web-a', r.data);
r = await A('GET', `/api/domains/${da.id}/dns`);
check('A reads its DNS', r.status === 200, r);
r = await A('GET', `/api/domains/${db_.id}/dns`);
check('A cannot read B DNS (404)', r.status === 404, r);
r = await A('POST', `/api/domains/${db_.id}/dns`, { name: 'x', type: 'A', ttl: 300, content: '1.2.3.4' });
check('A cannot write B DNS', r.status === 404, r);
r = await A('GET', `/api/domains/${dOwn.id}`);
check('A cannot read owner domain', r.status === 404, r);
r = await A('GET', `/api/sites/${siteB.id}`);
check('A cannot read B site', r.status === 404, r);
r = await A('GET', `/api/sites/${siteB.id}/files`);
check('A cannot list B files', r.status === 404, r);
r = await A('DELETE', `/api/sites/${siteB.id}`);
check('A cannot delete B site', r.status === 404, r);
r = await A('GET', `/api/sites/${siteA.id}`);
check('A reads its site', r.status === 200, r);
r = await A('DELETE', `/api/domains/${da.id}`);
check('A cannot delete its domain', r.status === 403, r);
r = await A('POST', '/api/domains', { name: 'nuevo.es' });
check('A cannot add domains', r.status === 403, r);

// Creating sites: only on own hostnames, only on this server.
r = await A('POST', '/api/sites', { name: 'robo', hostnames: ['cliente-b.es'], type: 'static', repo_url: '', branch: 'main' });
check('A cannot create site on B domain', r.status === 403, r);
r = await A('POST', '/api/sites', { name: 'mixto', hostnames: ['tienda.cliente-a.es', 'titular.es'], type: 'static', repo_url: '', branch: 'main' });
check('A cannot sneak a foreign hostname', r.status === 403, r);
r = await A('POST', '/api/sites', { name: 'remoto', hostnames: ['blog.cliente-a.es'], type: 'static', repo_url: '', branch: 'main', server_ids: [0, 5] });
check('A cannot deploy on other servers', r.status === 403, r);
r = await A('POST', '/api/sites', { name: 'blog-a', hostnames: ['blog.cliente-a.es'], type: 'static', repo_url: '', branch: 'main' });
check('A creates site on its subdomain', r.status === 200, r);
r = await A('PUT', `/api/sites/${siteA.id}`, { hostnames: ['cliente-a.es', 'cliente-b.es'] });
check('A cannot add B hostname to its site', r.status === 403, r);

// Mail.
r = await A('POST', '/api/mail/mailboxes', { email: 'hola@cliente-b.es', name: 'x' });
check('A cannot create mailbox on B domain', r.status === 403, r);
r = await A('DELETE', '/api/mail/mailboxes/info@cliente-b.es');
check('A cannot delete B mailbox', r.status === 404, r);
r = await A('GET', '/api/mail?domain=cliente-b.es');
check('A cannot list B mailboxes', r.status === 200 && r.data.mailboxes.length === 0 && r.data.domains.every((d) => d.name === 'cliente-a.es'), r.data);

// Databases.
const dbA = await A('POST', '/api/databases', { name: 'cliente_a_db' });
check('A creates database', dbA.status === 200, dbA);
const dbOwner = await owner('POST', '/api/databases', { name: 'titular_db' });
const ownerDbs = (await owner('GET', '/api/databases')).data;
const ownerDbId = ownerDbs.find((d) => d.name === 'titular_db')?.id;
r = await A('GET', '/api/databases');
check('A sees only its database', Array.isArray(r.data) && r.data.length === 1 && r.data[0].name === 'cliente_a_db', r.data);
r = await A('POST', `/api/databases/${ownerDbId}/query`, { sql: 'SELECT 1' });
check('A cannot query owner database', r.status === 404, r);

// Staff-only sections.
for (const [m, p] of [['GET', '/api/dashboard'], ['GET', '/api/clients'], ['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/workers'], ['GET', '/api/settings'], ['POST', '/api/updates/run'], ['GET', '/api/certificates'], ['GET', '/api/analytics'], ['GET', '/api/setup/state']]) {
  r = await A(m, p, m === 'POST' ? {} : undefined);
  check(`A denied ${m} ${p}`, r.status === 403, r);
}
r = await A('GET', '/api/certificates?hosts=cliente-a.es');
check('A sees SSL of its host', r.status === 200, r);
r = await A('GET', '/api/certificates?hosts=cliente-a.es,cliente-b.es');
check('A cannot see SSL of B host', r.status === 403, r);
r = await A('GET', '/api/server/identity');
check('identity hides domain list', r.status === 200 && r.data.candidates.length === 0, r.data);

// B is isolated the other way round.
const B = session();
await B('POST', '/api/auth/login', { username: 'pedro.b', password: ub.password });
r = await B('GET', '/api/sites');
check('B sees only its site', Array.isArray(r.data) && r.data.length === 1 && r.data[0].name === 'web-b', r.data);

// Suspension kicks the client out.
await owner('PUT', `/api/clients/${ca.id}`, { name: 'Cliente A', email: 'a@cliente-a.es', company: '', notes: '', status: 'suspended' });
r = await A('GET', '/api/sites');
check('suspended client loses session', r.status === 401, r);
r = await A('POST', '/api/auth/login', { username: 'lucia.a', password: ua.password });
check('suspended client cannot log in', r.status === 403, r);
await owner('PUT', `/api/clients/${ca.id}`, { name: 'Cliente A', email: 'a@cliente-a.es', company: '', notes: '', status: 'active' });
r = await A('POST', '/api/auth/login', { username: 'lucia.a', password: ua.password });
check('reactivated client logs in', r.status === 200, r);

// Team member: can manage clients but not the team or the owner.
const team = (await owner('POST', '/api/users', { username: 'soporte.marta', role: 'admin' })).data;
const T = session();
await T('POST', '/api/auth/login', { username: 'soporte.marta', password: team.password });
r = await T('GET', '/api/clients');
check('team sees clients', r.status === 200 && r.data.clients.length === 2, r.data);
r = await T('POST', '/api/users', { username: 'otro.admin', role: 'admin' });
check('team cannot add team members', r.status === 403, r);
const ownerId = (await owner('GET', '/api/users')).data.find((u) => u.role === 'owner').id;
r = await T('POST', `/api/users/${ownerId}/password`);
check('team cannot reset owner password', r.status === 403, r);
r = await T('GET', '/api/dashboard');
check('team reaches dashboard', r.status === 200, r);

// Deleting a client returns its domains to the holder and removes its logins.
r = await owner('DELETE', `/api/clients/${cb.id}`);
const domsAfter = (await owner('GET', '/api/domains')).data;
check('deleted client: domain back to holder', domsAfter.find((d) => d.name === 'cliente-b.es')?.client_id === null, domsAfter);
r = await B('GET', '/api/sites');
check('deleted client: session gone', r.status === 401, r);

console.log(results.join('\n'));
console.log(`\n${results.filter((x) => x.startsWith('OK')).length}/${results.length} OK`);
process.exit(results.some((x) => x.startsWith("FAIL")) ? 1 : 0);
