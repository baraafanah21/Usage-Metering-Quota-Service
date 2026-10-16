// The parts of the metering API's responses the demo reads (DESIGN.md §6.1, §8).

export interface PlanRules {
  monthlyAllowance?: number;
  maxUnitsPerRequest?: number;
}

export interface Plan {
  id: string;
  name: string;
  scope: "account" | "user";
  predefined: boolean;
  version: number;
  rules: PlanRules;
}

export interface Account {
  id: string;
  name: string;
  plan: Plan;
  currentMonth: { month: string; used: number; remaining: number | null };
}

export interface CreatedAccount {
  account: Account;
  apiKey: { id: string; key: string; prefix: string };
}

export interface User {
  externalId: string;
  plan: Plan;
}

export interface LevelLimits {
  planId: string;
  planName: string;
  planVersion: number;
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
  used: number;
  remaining: number | null;
}

export interface EffectiveLimits {
  month: string;
  account: LevelLimits;
  user: LevelLimits;
}

export interface Violation {
  scope: "account" | "user";
  rule: string;
  limit: number;
  message: string;
}

export interface ConsumeResponse {
  requestId: string;
  decision: "accepted" | "rejected";
  units: number;
  month: string;
  reason?: Violation;
  violations: Violation[];
  account: LevelLimits;
  user: LevelLimits;
  replayed: boolean;
}

export interface LedgerEntry {
  requestId: string;
  userId: string;
  units: number;
  decision: "accepted" | "rejected";
  reason: { scope: "account" | "user"; rule: string } | null;
  month: string;
  createdAt: string;
}
