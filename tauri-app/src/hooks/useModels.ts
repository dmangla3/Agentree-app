import { useMemo } from 'react';
import {
    bootstrapRuntimeModels,
    projectRuntimeCatalogModel,
    type RuntimeCatalogModel,
} from '../lib/runtimeModels';
import { useRuntimeModelCatalog } from './useAgents';

// Compatibility projection for graph/search consumers. It is derived from the
// canonical RuntimeModel catalog and contains no fabricated pricing metadata.
export const runtimeCatalogModels: RuntimeCatalogModel[] = bootstrapRuntimeModels
    .map(projectRuntimeCatalogModel);

export const useModels = () => {
    const catalogQuery = useRuntimeModelCatalog();
    const models = useMemo(
        () => catalogQuery.data.map(projectRuntimeCatalogModel),
        [catalogQuery.data],
    );
    return { ...catalogQuery, data: models };
};
