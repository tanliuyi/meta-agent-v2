import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authenticate,
  createManagedVersion,
  deleteManagedDraft,
  deleteRating,
  deprecateManagedVersion,
  getCurrentUser,
  getDownload,
  getPlugin,
  getRatings,
  listAdminPublishers,
  listAdminUsers,
  listManagedPlugins,
  listPlugins,
  logout,
  MarketplaceApiError,
  type PublishPluginInput,
  type PublishVersionInput,
  publishManagedVersion,
  ratePlugin,
  type UserRole,
  updateAdminPublisherMember,
  updateAdminUserRole,
  uploadManagedArtifact,
  upsertAdminPublisher,
  upsertManagedPlugin,
} from "./api.ts";
import { clearSession, readSession, type SessionState, writeSession } from "./lib/marketplace-ui.ts";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function useSession() {
  return useQuery<SessionState | null>({
    queryKey: ["session"],
    queryFn: () => readSession() ?? null,
    staleTime: Infinity,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

export function useCurrentUser(token: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["currentUser", token],
    queryFn: ({ signal }) => withSessionAuth(queryClient, token!, () => getCurrentUser(token!, signal)),
    enabled: !!token,
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Plugin list (infinite)
// ---------------------------------------------------------------------------

export function usePluginList({ query, category }: { query: string; category: string }) {
  return useInfiniteQuery({
    queryKey: ["plugins", { query, category }],
    queryFn: ({ pageParam }) =>
      listPlugins({
        query: query.trim() || undefined,
        category: category || undefined,
        cursor: pageParam as string | undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Plugin detail
// ---------------------------------------------------------------------------

export function usePluginDetail(pluginId: string) {
  return useQuery({
    queryKey: ["plugin", pluginId],
    queryFn: () => getPlugin(pluginId),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Plugin ratings
// ---------------------------------------------------------------------------

export function usePluginRatings(pluginId: string) {
  return useQuery({
    queryKey: ["ratings", pluginId],
    queryFn: () => getRatings(pluginId),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Auth mutations
// ---------------------------------------------------------------------------

export function useAuthLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authenticate("login", username, password),
    onSuccess: (authSession) => {
      writeSession({ token: authSession.token, expiresAt: authSession.expiresAt });
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
}

export function useAuthRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authenticate("register", username, password),
    onSuccess: (authSession) => {
      writeSession({ token: authSession.token, expiresAt: authSession.expiresAt });
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
}

export function useAuthLogout() {
  const queryClient = useQueryClient();
  return useMutation(authLogoutMutationOptions(queryClient));
}

export function authLogoutMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (token: string) => logout(token),
    networkMode: "always" as const,
    onMutate: (token: string) => clearClientSession(queryClient, token),
  };
}

// ---------------------------------------------------------------------------
// Rating mutations
// ---------------------------------------------------------------------------

export function useRatePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      pluginId,
      stars,
      review,
      token,
    }: {
      pluginId: string;
      stars: number;
      review: string;
      token: string;
    }) => withSessionAuth(queryClient, token, () => ratePlugin(pluginId, stars, review, token)),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["ratings", variables.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["plugin", variables.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useDeleteRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, token }: { pluginId: string; token: string }) =>
      withSessionAuth(queryClient, token, () => deleteRating(pluginId, token)),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["ratings", variables.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["plugin", variables.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Publisher management
// ---------------------------------------------------------------------------

export function useManagedPlugins(token: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["managedPlugins", token],
    queryFn: () => withSessionAuth(queryClient, token!, () => listManagedPlugins(token!)),
    enabled: !!token,
    staleTime: 10_000,
  });
}

function useManagedPluginMutation<TVariables extends { token: string }>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  pluginId: (variables: TVariables) => string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVariables) => withSessionAuth(queryClient, variables.token, () => mutationFn(variables)),
    onSuccess: (_data, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["managedPlugins"] }),
        queryClient.invalidateQueries({ queryKey: ["plugins"] }),
        queryClient.invalidateQueries({ queryKey: ["plugin", pluginId(variables)] }),
      ]),
  });
}

export function useUpsertManagedPlugin() {
  return useManagedPluginMutation(
    ({ pluginId, input, token }: { pluginId: string; input: PublishPluginInput; token: string }) =>
      upsertManagedPlugin(pluginId, input, token),
    ({ pluginId }) => pluginId,
  );
}

export function useCreateManagedVersion() {
  return useManagedPluginMutation(
    ({ pluginId, input, token }: { pluginId: string; input: PublishVersionInput; token: string }) =>
      createManagedVersion(pluginId, input, token),
    ({ pluginId }) => pluginId,
  );
}

export function useUploadManagedArtifact() {
  return useManagedPluginMutation(
    ({
      pluginId,
      version,
      artifactId,
      file,
      token,
    }: {
      pluginId: string;
      version: string;
      artifactId: string;
      file: File;
      token: string;
    }) => uploadManagedArtifact(pluginId, version, artifactId, file, token),
    ({ pluginId }) => pluginId,
  );
}

export function usePublishManagedVersion() {
  return useManagedPluginMutation(
    ({ pluginId, version, token }: { pluginId: string; version: string; token: string }) =>
      publishManagedVersion(pluginId, version, token),
    ({ pluginId }) => pluginId,
  );
}

export function useDeprecateManagedVersion() {
  return useManagedPluginMutation(
    ({ pluginId, version, token }: { pluginId: string; version: string; token: string }) =>
      deprecateManagedVersion(pluginId, version, token),
    ({ pluginId }) => pluginId,
  );
}

export function useDeleteManagedDraft() {
  return useManagedPluginMutation(
    ({ pluginId, version, token }: { pluginId: string; version: string; token: string }) =>
      deleteManagedDraft(pluginId, version, token),
    ({ pluginId }) => pluginId,
  );
}

export function useAdminUsers(token: string | null | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["adminUsers"],
    queryFn: () => withSessionAuth(queryClient, token!, () => listAdminUsers(token!)),
    enabled: !!token && enabled,
    staleTime: 10_000,
  });
}

export function useUpdateAdminUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, role, token }: { username: string; role: UserRole; token: string }) =>
      withSessionAuth(queryClient, token, () => updateAdminUserRole(username, role, token)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["adminUsers"] }),
        queryClient.invalidateQueries({ queryKey: ["currentUser"] }),
      ]),
  });
}

export function useAdminPublishers(token: string | null | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["adminPublishers"],
    queryFn: () => withSessionAuth(queryClient, token!, () => listAdminPublishers(token!)),
    enabled: !!token && enabled,
    staleTime: 10_000,
  });
}

export function useUpsertAdminPublisher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      publisherId,
      displayName,
      verified,
      token,
    }: {
      publisherId: string;
      displayName: string;
      verified: boolean;
      token: string;
    }) =>
      withSessionAuth(queryClient, token, () => upsertAdminPublisher(publisherId, { displayName, verified }, token)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adminPublishers"] }),
  });
}

export function useUpdateAdminPublisherMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      publisherId,
      username,
      operation,
      token,
    }: {
      publisherId: string;
      username: string;
      operation: "add" | "remove";
      token: string;
    }) =>
      withSessionAuth(queryClient, token, () => updateAdminPublisherMember(publisherId, username, operation, token)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["adminPublishers"] }),
        queryClient.invalidateQueries({ queryKey: ["managedPlugins"] }),
      ]),
  });
}

async function withSessionAuth<T>(queryClient: QueryClient, token: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 401) clearClientSession(queryClient, token);
    throw error;
  }
}

export function clearClientSession(queryClient: QueryClient, token: string): boolean {
  const storedSession = readSession();
  const cachedSession = queryClient.getQueryData<SessionState | null>(["session"]);
  if ((storedSession?.token ?? cachedSession?.token) !== token) return false;
  clearSession();
  queryClient.setQueryData(["session"], null);
  queryClient.removeQueries({ queryKey: ["managedPlugins"] });
  queryClient.removeQueries({ queryKey: ["currentUser"] });
  return true;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export function usePluginDownload() {
  return useMutation({
    mutationFn: ({ pluginId, version, artifactId }: { pluginId: string; version: string; artifactId: string }) =>
      getDownload(pluginId, version, artifactId),
  });
}
