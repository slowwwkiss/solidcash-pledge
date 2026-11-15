import { defineConfig } from '@solidcash/testing';

export default defineConfig({
  paths: {
    contracts: 'contracts',
    artifacts: 'artifacts',
    tests: 'test',
  },
  networks: {
    mock: { type: 'mock' },
  },
  defaultNetwork: 'mock',
  mnemonic: 'test test test test test test test test test test test junk',
});
