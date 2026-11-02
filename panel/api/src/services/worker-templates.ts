/** Starter code for new Workers (Cloudflare Workers API). */
export const WORKER_TEMPLATES: Record<string, { label: string; description: string; code: string }> = {
  hello: {
    label: 'Hola mundo',
    description: 'Responde a cada petición. El punto de partida más simple.',
    code: `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return new Response(\`¡Hola desde HostPanel Workers! Has pedido \${url.pathname}\`, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
`,
  },
  api: {
    label: 'API JSON con SQL',
    description: 'Una API REST pequeña sobre una base de datos MariaDB (añade el binding DB).',
    code: `// Añade en Configuración un binding de base de datos SQL llamado DB.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/setup') {
      await env.DB.exec(\`CREATE TABLE IF NOT EXISTS notas (id INTEGER PRIMARY KEY AUTO_INCREMENT, texto TEXT NOT NULL)\`);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/notas' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM notas ORDER BY id DESC LIMIT 50').all();
      return Response.json(results);
    }

    if (url.pathname === '/notas' && request.method === 'POST') {
      const { texto } = await request.json();
      const { meta } = await env.DB.prepare('INSERT INTO notas (texto) VALUES (?)').bind(texto).run();
      return Response.json({ id: meta.last_row_id }, { status: 201 });
    }

    return Response.json({ error: 'No encontrado' }, { status: 404 });
  },
};
`,
  },
  documents: {
    label: 'API JSON con NoSQL',
    description: 'Guarda y consulta documentos JSON sin esquema (añade el binding DOCS).',
    code: `// Añade en Configuración un binding de base de datos NoSQL llamado DOCS.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const notas = env.DOCS.collection('notas');

    if (url.pathname === '/notas' && request.method === 'GET') {
      const etiqueta = url.searchParams.get('etiqueta');
      const filtro = etiqueta ? { etiquetas: { $contains: etiqueta } } : {};
      return Response.json(await notas.find(filtro, { sort: { creada: -1 }, limit: 50 }));
    }

    if (url.pathname === '/notas' && request.method === 'POST') {
      const { texto, etiquetas = [] } = await request.json();
      const { insertedId } = await notas.insertOne({ texto, etiquetas, creada: Date.now() });
      return Response.json({ id: insertedId }, { status: 201 });
    }

    const id = url.pathname.startsWith('/notas/') ? url.pathname.slice('/notas/'.length) : '';
    if (id && request.method === 'DELETE') {
      const { deletedCount } = await notas.deleteOne({ _id: id });
      return Response.json({ borradas: deletedCount });
    }

    return Response.json({ error: 'No encontrado' }, { status: 404 });
  },
};
`,
  },
  kv: {
    label: 'Contador con KV',
    description: 'Guarda datos clave-valor con caducidad (añade el binding KV).',
    code: `// Añade en Configuración un binding KV llamado KV.
export default {
  async fetch(request, env) {
    const visitas = Number((await env.KV.get('visitas')) ?? 0) + 1;
    await env.KV.put('visitas', String(visitas));
    return Response.json({ visitas });
  },
};
`,
  },
  producer: {
    label: 'Productor de cola',
    description: 'Recibe peticiones y las encola para procesarlas después (binding QUEUE).',
    code: `// Añade en Configuración un binding de cola llamado QUEUE.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Envía un POST con JSON', { status: 405 });
    const pedido = await request.json();
    await env.QUEUE.send({ pedido, recibido: Date.now() });
    return Response.json({ encolado: true }, { status: 202 });
  },
};
`,
  },
  consumer: {
    label: 'Consumidor de cola',
    description: 'Procesa mensajes por lotes con reintentos (asígnalo como consumidor de una cola).',
    code: `// Asigna este Worker como consumidor en Colas → tu cola → Consumidor.
export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        console.log('Procesando', message.id, message.body);
        // … tu lógica (enviar un email, llamar a una API, guardar en la base de datos…)
        message.ack();
      } catch (err) {
        console.error('Fallo, se reintentará', err);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};
`,
  },
  cron: {
    label: 'Tarea programada',
    description: 'Se ejecuta según un cron, por ejemplo cada 5 minutos.',
    code: `// Añade un disparador cron en Disparadores (p. ej. */5 * * * *).
export default {
  async scheduled(event, env, ctx) {
    console.log('Ejecutando', event.cron, new Date(event.scheduledTime).toISOString());
    // ctx.waitUntil(fetch('https://mi-api.com/limpieza', { method: 'POST' }));
  },
};
`,
  },
  files: {
    label: 'Servidor de archivos',
    description: 'Sirve y sube archivos de un bucket (binding BUCKET).',
    code: `// Añade en Configuración un binding de almacenamiento llamado BUCKET.
export default {
  async fetch(request, env) {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!key) return new Response('Indica un archivo: /ruta/archivo.jpg', { status: 400 });

    if (request.method === 'PUT') {
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') } });
      return new Response('Guardado', { status: 201 });
    }

    const object = await env.BUCKET.get(key);
    if (!object) return new Response('No encontrado', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('cache-control', 'public, max-age=3600');
    return new Response(object.body, { headers });
  },
};
`,
  },
  proxy: {
    label: 'Proxy y redirecciones',
    description: 'Reescribe peticiones hacia otro origen o redirige según la ruta.',
    code: `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/blog')) {
      return Response.redirect('https://blog.ejemplo.com' + url.pathname.slice(5), 301);
    }
    // Reenvía el resto a otra API añadiendo una cabecera.
    const upstream = new URL(url.pathname + url.search, 'https://httpbin.org');
    const response = await fetch(upstream, request);
    const out = new Response(response.body, response);
    out.headers.set('x-servido-por', 'HostPanel Workers');
    return out;
  },
};
`,
  },
};
