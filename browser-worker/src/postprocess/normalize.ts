const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EPOCH_RE = /\d{10,13}/g;
const DIGITS_RE = /\d+/g;

export function normalize(s: string): string {
  let out = s.replace(UUID_RE, '<uuid>');
  out = out.replace(EPOCH_RE, '<ts>');
  out = out.replace(DIGITS_RE, '<n>');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

export interface SignatureInputArgs {
  error: string;
  topFrame: string;
  route: string | null;
  role: string;
}

export interface SignatureInput {
  normalized_error: string;
  top_stack_frame: string;
  route: string | null;
  role: string;
}

export function signatureInput({ error, topFrame, route, role }: SignatureInputArgs): SignatureInput {
  return {
    normalized_error: normalize(error),
    top_stack_frame: topFrame,
    route,
    role,
  };
}
