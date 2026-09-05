import { useMemo } from 'react';
import { getProductionAccountDeletionController } from '../lib/account/productionAccountDeletionController';

export function useAccountDeletion() {
  return useMemo(() => getProductionAccountDeletionController(), []);
}
