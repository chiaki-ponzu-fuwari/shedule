import * as Crypto from 'expo-crypto';
import {
  createAccountDeletionCoordinator,
  encodeDeletionSecret,
  type AccountDeletionStorage,
} from './accountDeletion';
import {
  createSupabaseAccountDeletionGateway,
  type AccountDeletionFunctionClient,
} from './supabaseAccountDeletionGateway';
import { getAccountOperationStorage, getSupabaseClient } from '../supabase';

export function createProductionAccountDeletionCoordinator() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Account deletion is unavailable until cloud setup is complete');
  return createAccountDeletionCoordinator({
    storage: getAccountOperationStorage() as AccountDeletionStorage,
    gateway: createSupabaseAccountDeletionGateway(
      client as unknown as AccountDeletionFunctionClient,
    ),
    randomUUID: () => Crypto.randomUUID(),
    randomSecret: () => encodeDeletionSecret(Crypto.getRandomBytes(32)),
  });
}

let productionCoordinator: ReturnType<typeof createProductionAccountDeletionCoordinator> | null = null;

export function getProductionAccountDeletionCoordinator() {
  if (!productionCoordinator) {
    productionCoordinator = createProductionAccountDeletionCoordinator();
  }
  return productionCoordinator;
}
