export interface ArtifactDraft {
  key: number;
  id: string;
  entry: string;
  platform: string;
  arch: string;
  preferred: boolean;
}

export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function createArtifactDraft(key: number): ArtifactDraft {
  return {
    key,
    id: key === 0 ? "universal" : `artifact-${key + 1}`,
    entry: "index.ts",
    platform: "universal",
    arch: "universal",
    preferred: true,
  };
}
