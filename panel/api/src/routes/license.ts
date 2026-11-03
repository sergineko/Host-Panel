import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../db.ts';
import { HttpError, parse } from '../lib/validate.ts';
import { activeBranding, DEFAULT_BRANDING, saveBranding, savedBranding } from '../services/branding.ts';
import { currentLicense, installLicense, licenseUsage, PLANS } from '../services/license.ts';

const MAX_LOGO = 300 * 1024;

export default async function licenseRoutes(app: FastifyInstance) {
  // Public: the login page needs the name, logo and colour before anyone signs in.
  app.get('/api/branding/public', async () => {
    const { name, logo, color } = activeBranding();
    return { name, logo, color };
  });

  // --- licence (staff; clients are denied in access.ts) ---------------------------------
  app.get('/api/license', async () => ({ ...licenseUsage(), plans: Object.values(PLANS) }));

  app.put('/api/license', async (req) => {
    if (req.user!.role !== 'owner') throw new HttpError(403, 'Solo el titular puede cambiar la licencia');
    const { token } = parse(z.object({ token: z.string().min(20).max(4000) }), req.body);
    const license = installLicense(token);
    audit(req.user!.username, 'license.install', `${license.id} (${license.plan})`, req.ip);
    return licenseUsage();
  });

  // --- branding -----------------------------------------------------------------------------
  app.get('/api/branding', async () => ({ ...savedBranding(), allowed: currentLicense().plan.branding }));

  app.put('/api/branding', async (req) => {
    if (!currentLicense().plan.branding) throw new HttpError(402, 'La marca propia está incluida en el plan Reseller');
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Escribe el nombre del panel').max(40),
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i, 'Color no válido (#rrggbb)')
          .nullable(),
        logo: z
          .string()
          .max(MAX_LOGO, 'El logo es demasiado grande (máximo 300 KB)')
          .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'El logo debe ser PNG, JPG, WEBP o SVG')
          .nullable(),
      }),
      req.body,
    );
    saveBranding({ name: body.name, color: body.color?.toLowerCase() ?? null, logo: body.logo });
    audit(req.user!.username, 'branding.update', body.name, req.ip);
    return { ...savedBranding(), allowed: true };
  });

  app.delete('/api/branding', async (req) => {
    saveBranding(DEFAULT_BRANDING);
    audit(req.user!.username, 'branding.reset', '', req.ip);
    return { ...savedBranding(), allowed: currentLicense().plan.branding };
  });
}
