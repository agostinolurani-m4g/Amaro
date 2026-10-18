import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const TOKEN_TTL_HOURS = Number(process.env.WATTLAB_TOKEN_TTL_HOURS ?? 24 * 7);

/** @type {Map<string, { memberId: number, expiresAt: string }>} */
const sessions = new Map();

export function getJwtSecret() {
  const secret = process.env.WATTLAB_JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("WATTLAB_JWT_SECRET is required in production.");
  }
  return secret ?? "dev-wattlab-secret-change-me";
}

export function createToken(member) {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
  const token = jwt.sign(
    { sub: String(member.id), email: member.email },
    getJwtSecret(),
    { expiresIn: `${TOKEN_TTL_HOURS}h` },
  );

  sessions.set(token, {
    memberId: member.id,
    expiresAt: expiresAt.toISOString(),
  });

  return { token, expiresAt: expiresAt.toISOString() };
}

export function revokeToken(token) {
  sessions.delete(token);
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt && Date.now() > Date.parse(session.expiresAt)) {
      sessions.delete(token);
      return null;
    }
    return {
      memberId: Number(payload.sub),
      email: String(payload.email ?? ""),
    };
  } catch {
    return null;
  }
}

export function isActiveMembership(status) {
  return status === "active";
}

export function publicMember(member) {
  return {
    id: member.id,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    membershipStatus: member.membershipStatus,
  };
}

export function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
