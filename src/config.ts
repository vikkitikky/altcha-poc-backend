import { ApiError } from './errors.js';

export interface KeyRing { active: string; keys: Record<string, string> }
export type CaptchaMode = 'pow' | 'pow+image';
export interface ImageSettings { enabled: boolean; length: number; ttl: number; rateLimit: number }
export const defaultImageSettings: ImageSettings = { enabled: false, length: 5, ttl: 120, rateLimit: 10 };
export const imageSettings = (config: CaptchaConfig): ImageSettings => ({ ...defaultImageSettings, ...config.image });
export const captchaMode = (policy: Policy): CaptchaMode => policy.mode ?? 'pow';
export interface Policy {
  mode?: CaptchaMode;
  cost: number;
  counterMin: number;
  counterMax: number;
  challengeTtl: number;
  tokenTtl: number;
  graphics?: boolean;
}
export interface Site {
  defaultAction: string;
  actions: Record<string, string>;
  origins: string[];
}
export interface ServiceClient { secret: string; sites: string[] }
export interface CaptchaConfig {
  challengeKeys: KeyRing;
  tokenKeys: KeyRing;
  sites: Record<string, Site>;
  policies: Record<string, Policy>;
  clients: Record<string, ServiceClient>;
  hisEnabled: boolean;
  image?: ImageSettings;
}
export interface Context { site_id: string; action: string; policy: string }
export const idPattern = /^[a-zA-Z0-9_.:-]{1,100}$/;
export const defaultPolicies: Record<string, Policy> = {
  standard: { cost: 5000, counterMin: 200, counterMax: 400, challengeTtl: 120, tokenTtl: 60 },
  strict: { cost: 10000, counterMin: 400, counterMax: 800, challengeTtl: 120, tokenTtl: 45 },
};
export function resolveContext(config: CaptchaConfig, siteId: string, action?: string, policy?: string): Context {
  const site = Object.hasOwn(config.sites, siteId) ? config.sites[siteId] : undefined;
  if (!site) throw new ApiError(400, 'SITE_INVALID');
  action ??= site.defaultAction;
  const effective = Object.hasOwn(site.actions, action) ? site.actions[action] : undefined;
  if (!effective) throw new ApiError(400, 'ACTION_INVALID');
  if (policy !== undefined && policy !== effective) throw new ApiError(400, 'POLICY_MISMATCH');
  return { site_id: siteId, action, policy: effective };
}
export function assertOrigin(config: CaptchaConfig, context: Context, origin?: string) {
  if (origin && !config.sites[context.site_id]!.origins.includes(origin)) throw new ApiError(403, 'ORIGIN_FORBIDDEN');
}
export function validateConfig(config: CaptchaConfig): void {
  const image = imageSettings(config);
  if (typeof image.enabled !== 'boolean') throw new Error('Invalid image enabled flag');
  for (const [value,min,max] of [[image.length,4,8],[image.ttl,1,600],[image.rateLimit,1,120]] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid image settings');
  }
  for (const ring of [config.challengeKeys, config.tokenKeys]) {
    if (!idPattern.test(ring.active) || !Object.hasOwn(ring.keys, ring.active)) throw new Error('Invalid active key');
    for (const [id, secret] of Object.entries(ring.keys)) {
      if (!idPattern.test(id) || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || secret.startsWith('replace-')) {
        throw new Error('Keys must contain at least 32 bytes of secret material');
      }
    }
  }
  const challengeSecrets = new Set(Object.values(config.challengeKeys.keys));
  if (Object.values(config.tokenKeys.keys).some((secret) => challengeSecrets.has(secret))) throw new Error('Use independent challenge and token keys');
  if (!Object.keys(config.sites).length || !Object.keys(config.clients).length) throw new Error('Configure sites and service clients');
  for (const [name, policy] of Object.entries(config.policies)) {
    if (!idPattern.test(name)) throw new Error('Invalid policy name');
    if (policy.graphics) throw new Error('Use policy.mode=pow+image instead of the legacy graphics flag');
    if (!['pow','pow+image'].includes(captchaMode(policy))) throw new Error('Invalid CAPTCHA mode');
    if (captchaMode(policy) === 'pow+image' && !image.enabled) throw new Error('Image policy requires CAPTCHA_IMAGE_ENABLED=true');
    const bounds: Array<[number, number, number]> = [
      [policy.cost, 1, 100000], [policy.counterMin, 1, 100000], [policy.counterMax, policy.counterMin, 100000],
      [policy.challengeTtl, 1, 600], [policy.tokenTtl, 1, 120],
    ];
    for (const [value, min, max] of bounds) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid policy bounds');
    }
  }
  for (const [id, site] of Object.entries(config.sites)) {
    if (!idPattern.test(id) || !Object.hasOwn(site.actions, site.defaultAction)) throw new Error('Invalid site/default action');
    for (const [action, policy] of Object.entries(site.actions)) {
      if (!idPattern.test(action) || !Object.hasOwn(config.policies, policy)) throw new Error('Invalid action/policy mapping');
    }
    for (const origin of site.origins) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Origins must be exact HTTP(S) origins');
    }
  }
  for (const [id, client] of Object.entries(config.clients)) {
    if (!idPattern.test(id) || typeof client.secret !== 'string' || Buffer.byteLength(client.secret) < 32
      || !/^[A-Za-z0-9_-]{32,512}$/.test(client.secret) || client.secret.startsWith('replace-') || !client.sites.length
      || client.sites.some((site) => !Object.hasOwn(config.sites, site))) throw new Error('Invalid service client');
  }
  if (new Set(Object.values(config.clients).map((client) => client.secret)).size !== Object.keys(config.clients).length) {
    throw new Error('Service client secrets must be unique');
  }
}
export function configFromEnv(env: NodeJS.ProcessEnv): CaptchaConfig {
  function json<T>(name: string, fallback?: T): T {
    const value = env[name];
    if (!value) { if (fallback !== undefined) return fallback; throw new Error(`Missing ${name}; run npm run setup:env`); }
    return JSON.parse(value) as T;
  }
  if (env.HIS_ENABLED !== undefined && !['true', 'false'].includes(env.HIS_ENABLED)) throw new Error('HIS_ENABLED must be true or false');
  if (env.CAPTCHA_IMAGE_ENABLED !== undefined && !['true','false'].includes(env.CAPTCHA_IMAGE_ENABLED)) throw new Error('CAPTCHA_IMAGE_ENABLED must be true or false');
  if (env.CAPTCHA_IMAGE_MAX_ATTEMPTS !== undefined) throw new Error('CAPTCHA_IMAGE_MAX_ATTEMPTS is inapplicable: one submitted answer per image; use CAPTCHA_IMAGE_RATE_LIMIT per IP/minute');
  const imageEnabled = env.CAPTCHA_IMAGE_ENABLED === 'true';
  const config: CaptchaConfig = {
    challengeKeys: json('CHALLENGE_KEYS_JSON'), tokenKeys: json('TOKEN_KEYS_JSON'),
    clients: json('INTERNAL_CLIENTS_JSON'), sites: json('SITES_JSON'),
    policies: json('POLICIES_JSON', imageEnabled ? { ...defaultPolicies, strict: { ...defaultPolicies.strict!, mode: 'pow+image' } } : defaultPolicies),
    hisEnabled: env.HIS_ENABLED === 'true',
    image: { enabled: imageEnabled, length: Number(env.CAPTCHA_IMAGE_LENGTH ?? 5), ttl: Number(env.CAPTCHA_IMAGE_TTL_SECONDS ?? 120), rateLimit: Number(env.CAPTCHA_IMAGE_RATE_LIMIT ?? 10) },
  };
  validateConfig(config);
  return config;
}
