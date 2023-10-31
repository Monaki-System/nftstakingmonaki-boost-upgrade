import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
} from '@ton/core';
import { StakingHelper } from './StakingHelper';

export type StakingMasterConfig = {
    items: Dictionary<Address, bigint>;
    rank_rewards: Dictionary<bigint, bigint>;
    jettonMaster: Address;
    jettonWalletCode: Cell;
    helperCode: Cell;
    admin: Address;
};

export function stakingMasterConfigToCell(config: StakingMasterConfig): Cell {
    return beginCell()
        .storeRef(
        beginCell()
            .storeDict(config.items)
            .storeDict(config.rank_rewards)
            .storeDict(null)
        .endCell())
        .storeAddress(config.jettonMaster)
        .storeRef(config.jettonWalletCode)
        .storeRef(config.helperCode)
        .storeAddress(config.admin)
        .endCell();
}

export class StakingMaster implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new StakingMaster(address);
    }

    static createFromConfig(config: StakingMasterConfig, code: Cell, workchain = 0) {
        const data = stakingMasterConfigToCell(config);
        const init = { code, data };
        return new StakingMaster(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendAdminJettonsWithdrawal(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        amount: bigint
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x4fa096c8, 32).storeUint(queryId, 64).storeCoins(amount).endCell(),
        });
    }

    async sendAdminAddItems(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        items: Dictionary<Address, bigint>
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x256f691, 32).storeUint(queryId, 64).storeDict(items).endCell(),
        });
    }

    async sendAdminRemoveItems(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        items: Address[]
    ) {
        let itemsDict = Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4));
        items.forEach((item) => {
            itemsDict = itemsDict.set(item, 0n);
        });
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x5a7add91, 32).storeUint(queryId, 64).storeDict(itemsDict).endCell(),
        });
    }

    async getHelper(provider: ContractProvider, item: Address): Promise<StakingHelper> {
        const stack = (
            await provider.get('get_helper_address', [
                { type: 'slice', cell: beginCell().storeAddress(item).endCell() },
            ])
        ).stack;
        return StakingHelper.createFromAddress(stack.readAddress());
    }

    async getStakedItems(provider: ContractProvider): Promise<Dictionary<Address, Address>> {
        const stack = (await provider.get('get_staked_items', [])).stack;
        const d = stack.readCellOpt();
        if (d) {
            return d.beginParse().loadDictDirect(Dictionary.Keys.Address(), Dictionary.Values.Address());
        }
        return Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.Address());
    }

    async getItemsStakedByUser(provider: ContractProvider, user: Address): Promise<Address[]> {
        const dict = await this.getStakedItems(provider);
        for (const [key, value] of dict) {
            if (!value.equals(user)) {
                dict.delete(key);
            }
        }
        return dict.keys();
    }

    async getEstimatedRewards(provider: ContractProvider, item: Address, timePassed: number): Promise<bigint> {
        const stack = (
            await provider.get('get_estimated_reward', [
                { type: 'slice', cell: beginCell().storeAddress(item).endCell() },
                { type: 'int', value: BigInt(timePassed) },
            ])
        ).stack;
        return stack.readBigNumber();
    }

    async getItems(provider: ContractProvider): Promise<Dictionary<Address, bigint>> {
        const stack = (await provider.get('get_items', [])).stack;
        let d = stack.readCellOpt();
        if (d) {
            return d.beginParse().loadDictDirect(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4));
        } else {
            return Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4));
        }
    }
}
