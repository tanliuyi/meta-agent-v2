export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
	find(provider: string, id: string): T | undefined;
	getAvailable(): readonly T[];
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
	registry: ModelRegistryLike<T>,
	provider: string,
	id: string,
): T | undefined {
	const available = registry.getAvailable();
	const direct = available.find(model => model.provider === provider && model.id === id);
	if (direct) return direct;

	const routedId = `${provider}/${id}`;
	// If multiple routers expose the same model ID, Pi's available-model ordering
	// determines which route is selected. An explicit provider/model selector can
	// select a specific route when that distinction matters.
	const routed = available.find(model => model.id === routedId);
	return routed ?? registry.find(provider, id);
}
