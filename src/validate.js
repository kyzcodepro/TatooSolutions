import { bad } from './http.js';

export function str(value, field, { required = true, max = 500, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`"${field}" is required`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`"${field}" must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw bad(`"${field}" is required`);
  if (trimmed.length < min) throw bad(`"${field}" must be at least ${min} characters`);
  if (trimmed.length > max) throw bad(`"${field}" must be at most ${max} characters`);
  return trimmed;
}

export function int(value, field, { required = true, min = 0, max = 100000000, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`"${field}" is required`);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw bad(`"${field}" must be a number`);
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) throw bad(`"${field}" must be between ${min} and ${max}`);
  return rounded;
}

export function oneOf(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`"${field}" is required`);
  }
  if (!allowed.includes(value)) throw bad(`"${field}" must be one of: ${allowed.join(', ')}`);
  return value;
}

export function email(value, field = 'email') {
  const v = str(value, field, { max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) throw bad(`"${field}" must be a valid email address`);
  return v;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function stringList(value, field, { max = 12, itemMax = 300 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  if (arr.length > max) throw bad(`"${field}" accepts at most ${max} entries`);
  return arr
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => {
      if (item.length > itemMax) throw bad(`"${field}" entries must be at most ${itemMax} characters`);
      return item;
    });
}

export function isoDate(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`"${field}" is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw bad(`"${field}" must be a valid date`);
  return date.toISOString();
}

export function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
