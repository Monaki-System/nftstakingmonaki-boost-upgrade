import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    Slice,
} from '@ton/core';
import { StakingHelper } from './StakingHelper';

export type Reward = {
    commonReward: bigint;
    boostReward: bigint;
};

export type UserData = {
    firstNftCount: bigint;
    firstStartFrom: bigint;
    firstExtraReward: bigint;
    secondNftCount: bigint;
    secondStartFrom: bigint;
    secondExtraReward: bigint;
};

export type StakingMasterConfig = {
    items: Dictionary<Address, bigint>;
    rarity: Dictionary<bigint, Reward>;
    jettonMaster: Address;
    jettonWalletCode: Cell;
    helperCode: Cell;
    admin: Address;
    validUntil: bigint;
};

export function createRewardValue(): DictionaryValue<Reward> {
    return {
        parse: (src: Slice): Reward => {
            return {
                commonReward: src.loadCoins(),
                boostReward: src.loadCoins(),
            };
        },
        serialize: (src: Reward, dest: Builder) => {
            dest.storeCoins(src.commonReward);
            dest.storeCoins(src.boostReward);
        },
    };
}

export function createUserDataValue(): DictionaryValue<UserData> {
    return {
        parse: (src: Slice): UserData => {
            return {
                firstNftCount: src.loadUintBig(16),
                firstStartFrom: src.loadUintBig(64),
                firstExtraReward: src.loadCoins(),
                secondNftCount: src.loadUintBig(16),
                secondStartFrom: src.loadUintBig(64),
                secondExtraReward: src.loadCoins(),
            };
        },
        serialize: (src: UserData, dest: Builder) => {
            dest.storeUint(src.firstNftCount, 16);
            dest.storeUint(src.firstStartFrom, 64);
            dest.storeCoins(src.firstExtraReward);
            dest.storeUint(src.secondNftCount, 16);
            dest.storeUint(src.secondStartFrom, 64);
            dest.storeCoins(src.secondExtraReward);
        },
    };
}

export function stakingMasterConfigToCell(config: StakingMasterConfig): Cell {
    return beginCell()
        .storeRef(
            beginCell().storeDict(config.items).storeDict(config.rarity).storeDict(null).storeDict(null).endCell()
        )
        .storeAddress(config.jettonMaster)
        .storeRef(config.jettonWalletCode)
        .storeRef(config.helperCode)
        .storeAddress(config.admin)
        .storeUint(config.validUntil, 64)
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
            body: beginCell().storeUint(0x6d9a7414, 32).storeUint(queryId, 64).storeDict(items).endCell(),
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
            body: beginCell().storeUint(0x6d42583f, 32).storeUint(queryId, 64).storeDict(itemsDict).endCell(),
        });
    }

    async sendAdminAddRarity(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        rarity: Dictionary<bigint, Reward>
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0xcd2899a, 32).storeUint(queryId, 64).storeDict(rarity).endCell(),
        });
    }

    async sendAdminRemoveRarity(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        rarity: Dictionary<bigint, Reward>
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x487a18c8, 32).storeUint(queryId, 64).storeDict(rarity).endCell(),
        });
    }

    async sendAdminChangeValidUntil(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        validUntil: bigint
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0x58fe0363, 32).storeUint(queryId, 64).storeUint(validUntil, 64).endCell(),
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

    async getEstimatedRewards(provider: ContractProvider, item: Address, timePassed: number): Promise<bigint> {
        const stack = (
            await provider.get('get_estimated_reward', [
                { type: 'slice', cell: beginCell().storeAddress(item).endCell() },
                { type: 'int', value: BigInt(timePassed) },
            ])
        ).stack;
        return stack.readBigNumber();
    }

    async getContractData(provider: ContractProvider): Promise<{
        items: Dictionary<Address, bigint>;
        rarity: Dictionary<bigint, Reward>;
        users: Dictionary<Address, UserData>;
        stakedItems: Dictionary<Address, Address>;
        jettonMaster: Address;
        jettonWalletCode: Cell;
        helperCode: Cell;
        admin: Address;
        validUntil: bigint;
    }> {
        const stack = (await provider.get('get_contract_data', [])).stack;
        return {
            items:
                stack
                    .readCellOpt()
                    ?.beginParse()
                    .loadDictDirect(Dictionary.Keys.Address(), Dictionary.Values.BigUint(16)) ??
                Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigUint(16)),
            rarity:
                stack.readCellOpt()?.beginParse().loadDictDirect(Dictionary.Keys.BigUint(16), createRewardValue()) ??
                Dictionary.empty(Dictionary.Keys.BigUint(16), createRewardValue()),
            users:
                stack.readCellOpt()?.beginParse().loadDictDirect(Dictionary.Keys.Address(), createUserDataValue()) ??
                Dictionary.empty(Dictionary.Keys.Address(), createUserDataValue()),
            stakedItems:
                stack
                    .readCellOpt()
                    ?.beginParse()
                    .loadDictDirect(Dictionary.Keys.Address(), Dictionary.Values.Address()) ??
                Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.Address()),
            jettonMaster: stack.readAddress(),
            jettonWalletCode: stack.readCell(),
            helperCode: stack.readCell(),
            admin: stack.readAddress(),
            validUntil: stack.readBigNumber(),
        };
    }

    async getItemsStakedByUser(
        provider: ContractProvider,
        user: Address,
        dict: Dictionary<Address, Address>
    ): Promise<Address[]> {
        for (const [key, value] of dict) {
            if (!value.equals(user)) {
                dict.delete(key);
            }
        }
        return dict.keys();
    }
}
