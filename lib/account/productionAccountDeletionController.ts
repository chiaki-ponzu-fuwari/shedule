import { createAccountDeletionController } from './accountDeletionController';
import { getProductionAccountDeletionCoordinator } from './productionAccountDeletion';
import { clearProductionDeletedAccount } from './productionAccountDeletionCleanup';
import { createProductionAccountAuthGateway } from '../../hooks/useAccountAuth';
import { useAccountStore } from '../../store/accountStore';

let productionController: ReturnType<typeof createAccountDeletionController> | null = null;

export function getProductionAccountDeletionController() {
  if (!productionController) {
    productionController = createAccountDeletionController({
      deletion: {
        begin: (ownerId) => getProductionAccountDeletionCoordinator().begin(ownerId),
        read: () => getProductionAccountDeletionCoordinator().read(),
        execute: (input) => getProductionAccountDeletionCoordinator().execute(input),
        recover: () => getProductionAccountDeletionCoordinator().recover(),
        acknowledgeCompleted: (requestId) =>
          getProductionAccountDeletionCoordinator().acknowledgeCompleted(requestId),
      },
      reauthenticate: (provider, ownerId) =>
        createProductionAccountAuthGateway().reauthenticate(provider, ownerId, {
          purpose: 'account-deletion',
        }),
      cleanup: clearProductionDeletedAccount,
      markDeletionPending: () => useAccountStore.getState().markDeletionPending(),
      markError: (message) => useAccountStore.getState().markError(message),
    });
  }
  return productionController;
}

export async function recoverPendingAccountDeletion() {
  return getProductionAccountDeletionController().recover();
}
