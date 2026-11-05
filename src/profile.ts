import path from 'node:path';

export function profileDirectory(base: string, profile: string): string {
  if (!profile) return base;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('KITCHEN_PROFILE must contain only letters, digits, underscores or hyphens (max 64)');
  return path.join(base, 'profiles', profile);
}
