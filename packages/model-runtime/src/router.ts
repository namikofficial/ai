import type { ModelProfileRecord } from "../../shared/src/index.ts";
import type { ModelRouteDecision, ModelRouteInput } from "./index.ts";

export interface ModelRouter {
  route(input: ModelRouteInput): Promise<ModelRouteDecision>;
}

export class HeuristicModelRouter implements ModelRouter {
  private readonly profiles: ModelProfileRecord[];

  constructor(profiles: ModelProfileRecord[]) {
    this.profiles = profiles;
  }

  async route(input: ModelRouteInput): Promise<ModelRouteDecision> {
    const candidates = this.profiles.filter((profile) => profile.role === input.role && profile.enabled);
    const localCandidates = candidates.filter((profile) => profile.localOnly);
    const _cloudCandidates = candidates.filter((profile) => !profile.localOnly);

    const pickBest = (list: ModelProfileRecord[]): ModelProfileRecord | null =>
      list.slice().sort((left, right) => this.scoreProfile(right, input) - this.scoreProfile(left, input))[0] ?? null;

    if (input.mode === "cloud" && !input.cloudEnabled) {
      const fallback = input.fallbackProfileId ?? pickBest(localCandidates)?.id ?? pickBest(candidates)?.id ?? null;
      return {
        profileId: null,
        fallbackProfileId: fallback,
        blocked: true,
        reason: "cloud disabled",
      };
    }

    if (input.mode === "local") {
      const profile = pickBest(localCandidates) ?? pickBest(candidates);
      return {
        profileId: profile?.id ?? null,
        fallbackProfileId: input.fallbackProfileId ?? null,
        blocked: profile == null,
        reason: profile ? "local profile selected" : "no matching local profile",
      };
    }

    const profile = pickBest(candidates) ?? pickBest(localCandidates);
    return {
      profileId: profile?.id ?? null,
      fallbackProfileId: input.fallbackProfileId ?? null,
      blocked: profile == null,
      reason: profile ? "profile selected" : "no matching profile",
    };
  }

  private scoreProfile(profile: ModelProfileRecord, input: ModelRouteInput): number {
    const questionLength = input.details?.question?.trim().length ?? 0;
    const depth = input.details?.depth ?? "standard";
    const risk = input.details?.risk ?? "low";
    const contextNeed = input.details?.contextTokens ?? Math.max(2048, Math.min(32_768, questionLength * 64));

    const contextWindow = profile.contextWindow ?? 0;
    const contextFit = contextWindow <= 0 ? 0 : Math.max(0, Math.min(1, contextNeed / contextWindow));
    const contextBonus = contextWindow >= contextNeed ? 0.2 : -0.2 * (1 - contextFit);

    const depthBonus = depth === "deep" ? Math.min(0.2, contextWindow / 32_768) : depth === "shallow" ? -0.05 : 0;
    const riskBonus = risk === "high" ? Math.min(0.15, profile.qualityScore * 0.15) : risk === "medium" ? 0.05 : 0;

    const roleBonus =
      (input.role === "planner" && profile.modelName.includes("planner")) ||
      (input.role === "answer" && profile.modelName.includes("ask")) ||
      (input.role === "embedding" && profile.modelName.includes("embedding"))
        ? 0.08
        : 0;

    return (
      profile.qualityScore * 0.5 +
      profile.latencyScore * 0.2 +
      profile.costScore * 0.15 +
      contextBonus +
      depthBonus +
      riskBonus +
      roleBonus +
      (profile.localOnly ? 0.03 : 0)
    );
  }
}
