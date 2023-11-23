import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton/sandbox';
import { Cell, Dictionary, beginCell, toNano } from '@ton/core';
import { StakingMaster, createRewardValue } from '../wrappers/StakingMaster';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter } from '../wrappers/JettonMinter';
import { NFTCollection } from '../wrappers/NFTCollection';
import { JettonWallet } from '../wrappers/JettonWallet';
import { randomAddress } from '@ton/test-utils';

expect.extend({
    toEqualDict(received: Dictionary<any, any>, expected: Dictionary<any, any>) {
        const pass = beginCell()
            .storeDictDirect(received)
            .endCell()
            .equals(beginCell().storeDictDirect(expected).endCell());
        if (pass) {
            return {
                message: () => `expected ${received} not to equal ${expected}`,
                pass: true,
            };
        } else {
            return {
                message: () => `expected ${received} to equal ${expected}`,
                pass: false,
            };
        }
    },
});

declare global {
    namespace jest {
        interface Matchers<R> {
            toEqualDict(expected: Dictionary<any, any>): CustomMatcherResult;
        }
    }
}

describe('Staking', () => {
    let codeMaster: Cell;
    let codeHelper: Cell;
    let codeJettonMinter: Cell;
    let codeJettonWallet: Cell;
    let codeNFTCollection: Cell;
    let codeNFTItem: Cell;

    beforeAll(async () => {
        codeMaster = await compile('StakingMaster');
        codeHelper = await compile('StakingHelper');
        codeJettonMinter = await compile('JettonMinter');
        codeJettonWallet = await compile('JettonWallet');
        codeNFTCollection = await compile('NFTCollection');
        codeNFTItem = await compile('NFTItem');
    });

    let blockchain: Blockchain;
    let stakingMaster: SandboxContract<StakingMaster>;
    let jettonMinter: SandboxContract<JettonMinter>;
    let collection: SandboxContract<NFTCollection>;
    let users: SandboxContract<TreasuryContract>[];

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1600000000;

        users = await blockchain.createWallets(5);

        // deploy jetton minter
        jettonMinter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: users[0].address,
                    content: Cell.EMPTY,
                    walletCode: codeJettonWallet,
                },
                codeJettonMinter
            )
        );
        await jettonMinter.sendDeploy(users[0].getSender(), toNano('0.05'));

        // deploy collection
        collection = blockchain.openContract(
            NFTCollection.createFromConfig(
                {
                    owner: users[0].address,
                    collectionContent: Cell.EMPTY,
                    commonContent: Cell.EMPTY,
                    itemCode: codeNFTItem,
                    royaltyBase: 100n,
                    royaltyFactor: 100n,
                },
                codeNFTCollection
            )
        );
        await collection.sendDeploy(users[0].getSender(), toNano('0.05'));

        // deploy some items and add them to dictionary
        let items = Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigUint(16));
        let rarity = Dictionary.empty(Dictionary.Keys.BigUint(16), createRewardValue());
        for (let i = 0; i < 20; i++) {
            const item = (await collection.sendMint(users[0].getSender(), toNano('1'), i)).result;
            if (i == 1) {
                items = items.set(item.address, BigInt(2));
                continue;
            }
            items = items.set(item.address, BigInt(1));
        }

        rarity = rarity.set(BigInt(1), { commonReward: toNano('1'), boostReward: toNano('0.001') });
        rarity = rarity.set(BigInt(2), { commonReward: toNano('2'), boostReward: toNano('4') });

        stakingMaster = blockchain.openContract(
            StakingMaster.createFromConfig(
                {
                    items,
                    rarity,
                    jettonMaster: jettonMinter.address,
                    jettonWalletCode: codeJettonWallet,
                    helperCode: codeHelper,
                    admin: users[0].address,
                    validUntil: 1800000000n,
                },
                codeMaster
            )
        );

        const deployResult = await stakingMaster.sendDeploy(users[0].getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: users[0].address,
            to: stakingMaster.address,
            deploy: true,
            success: true,
        });

        // mint some jettons to staking master
        await jettonMinter.sendMint(
            users[0].getSender(),
            toNano('0.05'),
            toNano('0.1'),
            stakingMaster.address,
            toNano('10000000000')
        );
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and stakingMaster are ready to use
    });

    it('should add more items by admin', async () => {
        expect((await stakingMaster.getContractData()).items.keys()).toHaveLength(20);

        const result = await stakingMaster.sendAdminAddItems(
            users[0].getSender(),
            toNano('0.05'),
            123n,
            Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigUint(16)).set(
                (
                    await collection.sendMint(users[0].getSender(), toNano('0.05'), 20)
                ).result.address,
                1n
            )
        );

        expect(result.transactions).toHaveTransaction({
            from: users[0].address,
            to: stakingMaster.address,
            success: true,
        });
        expect((await stakingMaster.getContractData()).items.keys()).toHaveLength(21);
    });

    it('should remove items by admin', async () => {
        expect((await stakingMaster.getContractData()).items.keys()).toHaveLength(20);

        const result = await stakingMaster.sendAdminRemoveItems(
            users[0].getSender(),
            toNano('0.10'),
            123n,
            (await stakingMaster.getContractData()).items.keys()
        );

        expect(result.transactions).toHaveTransaction({
            from: users[0].address,
            to: stakingMaster.address,
            success: true,
        });
        expect((await stakingMaster.getContractData()).items.keys()).toHaveLength(0);
    });

    it('should withdraw jettons by admin', async () => {
        const result = await stakingMaster.sendAdminJettonsWithdrawal(
            users[0].getSender(),
            toNano('0.15'),
            123n,
            toNano('0.1')
        );

        expect(result.transactions).toHaveTransaction({
            from: users[0].address,
            to: stakingMaster.address,
            success: true,
        });
        expect(
            await blockchain
                .openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address)))
                .getJettonBalance()
        ).toEqual(toNano('0.1'));
    });

    it('should stake items', async () => {
        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(0n));

            const result = await item.sendTransfer(
                users[0].getSender(),
                toNano('0.4'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );

            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: helper.address,
                success: true,
                deploy: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.1'),
            });
            expect(await helper.getStaker()).toEqualAddress(users[0].address);
            expect(await helper.getStakedAt()).toEqual(1600000000);
            expect(await helper.getOption()).toEqual(7);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(1n));
            await item.sendTransfer(users[0].getSender(), toNano('0.2'), users[1].address);

            const result = await item.sendTransfer(
                users[1].getSender(),
                toNano('0.2'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(30, 8).endCell(),
                toNano('0.15')
            );

            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: helper.address,
                success: true,
                deploy: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.1'),
            });
            expect(await helper.getStaker()).toEqualAddress(users[1].address);
            expect(await helper.getStakedAt()).toEqual(1600000000);
            expect(await helper.getOption()).toEqual(30);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[1].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }
    });

    it('should not stake items not from dict', async () => {
        const item = blockchain.openContract(
            (await collection.sendMint(users[0].getSender(), toNano('0.05'), 20)).result
        );

        const result = await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
            toNano('0.15')
        );

        expect(result.transactions).toHaveTransaction({
            on: stakingMaster.address,
            success: true,
        });
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(result.transactions).not.toHaveTransaction({
            from: stakingMaster.address,
            to: helper.address,
            success: true,
            deploy: true,
        });
        expect(result.transactions).not.toHaveTransaction({
            from: stakingMaster.address,
            to: users[0].address,
            value: toNano('0.1'),
        });
        expect(await item.getOwner()).toEqualAddress(users[0].address);
        expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
    });

    it('should not stake with wrong option', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));

        const result = await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(123, 8).endCell(),
            toNano('0.15')
        );

        expect(result.transactions).toHaveTransaction({
            on: stakingMaster.address,
            success: true,
        });
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(result.transactions).not.toHaveTransaction({
            from: stakingMaster.address,
            to: helper.address,
            success: true,
            deploy: true,
        });
        expect(result.transactions).not.toHaveTransaction({
            from: stakingMaster.address,
            to: users[0].address,
            value: toNano('0.1'),
        });
        expect(await item.getOwner()).toEqualAddress(users[0].address);
        expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
    });

    it('should claim rewards', async () => {
        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
            await item.sendTransfer(
                users[0].getSender(),
                toNano('0.2'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(await helper.getStakedAt()).toEqual(1600000000);
            expect(await helper.getOption()).toEqual(7);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);

            blockchain.now = 1600000000 + 86400 * 7;

            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }

        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
            await item.sendTransfer(
                users[0].getSender(),
                toNano('0.2'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(14, 8).endCell(),
                toNano('0.15')
            );
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(await helper.getStakedAt()).toEqual(1600000000 + 86400 * 7);
            expect(await helper.getOption()).toEqual(14);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);

            blockchain.now = 1600000000 + 86400 * (7 + 14);

            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('21'));

            expect(await helper.getStakedAt()).toEqual(0);
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }

        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(1n));
            await item.sendTransfer(
                users[0].getSender(),
                toNano('0.2'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(await helper.getStakedAt()).toEqual(1600000000 + 86400 * (7 + 14));
            expect(await helper.getOption()).toEqual(7);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);

            blockchain.now = 1600000000 + 86400 * (7 + 14 + 7);

            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('35'));

            expect(await helper.getStakedAt()).toEqual(0);
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should not claim without paying the fine', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
        await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
            toNano('0.15')
        );
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(await helper.getStakedAt()).toEqual(1600000000);
        expect(await helper.getOption()).toEqual(7);
        expect(
            (
                await stakingMaster.getItemsStakedByUser(
                    users[0].address,
                    (
                        await stakingMaster.getContractData()
                    ).stakedItems
                )
            )[0]
        ).toEqualAddress(item.address);

        blockchain.now = 1600000000 + 86400 * 7;

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.2'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: helper.address,
                exitCode: 704,
            });
        }

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.3'),
            });
        }
    });

    it('should not claim until time passes', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
        await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
            toNano('0.15')
        );
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(await helper.getStakedAt()).toEqual(1600000000);
        expect(await helper.getOption()).toEqual(7);
        expect(
            (
                await stakingMaster.getItemsStakedByUser(
                    users[0].address,
                    (
                        await stakingMaster.getContractData()
                    ).stakedItems
                )
            )[0]
        ).toEqualAddress(item.address);

        blockchain.now = 1600000000 + 86400 * 7 - 1;

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: helper.address,
                exitCode: 703,
            });
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * 7;

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should not claim twice with `returnItem = true`', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
        await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
            toNano('0.15')
        );
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(await helper.getStakedAt()).toEqual(1600000000);
        expect(await helper.getOption()).toEqual(7);
        expect(
            (
                await stakingMaster.getItemsStakedByUser(
                    users[0].address,
                    (
                        await stakingMaster.getContractData()
                    ).stakedItems
                )
            )[0]
        ).toEqualAddress(item.address);

        blockchain.now = 1600000000 + 86400 * 7;

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }

        blockchain.now = 1600000000 + 86400 * (7 + 7);

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: helper.address,
                success: false,
            });
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should claim multiple times with `returnItem = false`', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
        await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
            toNano('0.15')
        );
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(await helper.getStakedAt()).toEqual(1600000000);
        expect(await helper.getOption()).toEqual(7);
        expect(
            (
                await stakingMaster.getItemsStakedByUser(
                    users[0].address,
                    (
                        await stakingMaster.getContractData()
                    ).stakedItems
                )
            )[0]
        ).toEqualAddress(item.address);

        blockchain.now = 1600000000 + 86400 * 7;

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * (7 + 7);

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('14'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * (7 + 7 + 7);

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('21'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }

        blockchain.now = 1600000000 + 86400 * (7 + 7 + 7 + 7);

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: helper.address,
                success: false,
            });
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should claim multiple times in a row for 30-days option', async () => {
        const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
        await item.sendTransfer(
            users[0].getSender(),
            toNano('0.2'),
            stakingMaster.address,
            beginCell().storeUint(0x429c67c7, 32).storeUint(30, 8).endCell(),
            toNano('0.15')
        );
        const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
        expect(await helper.getStakedAt()).toEqual(1600000000);
        expect(await helper.getOption()).toEqual(30);
        expect(
            (
                await stakingMaster.getItemsStakedByUser(
                    users[0].address,
                    (
                        await stakingMaster.getContractData()
                    ).stakedItems
                )
            )[0]
        ).toEqualAddress(item.address);

        blockchain.now = 1600000000 + 86400 * 30 - 1;
        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: helper.address,
                success: false,
            });
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * 30;
        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('30'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * (30 + 1);
        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('31'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * (30 + 5);
        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('35'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        blockchain.now = 1600000000 + 86400 * (30 + 36);
        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('66'));
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);
        }

        {
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('66'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should claim rewards with boost', async () => {
        {
            for (let i = 9; i < 19; i++) {
                const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(i)));
                await item.sendTransfer(
                    users[0].getSender(),
                    toNano('0.2'),
                    stakingMaster.address,
                    beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                    toNano('0.15')
                );
            }

            blockchain.now = 1600000000 + 86400 * 7;

            for (let i = 9; i < 18; i++) {
                const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(i)));
                const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
                const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
                expect(result.transactions).toHaveTransaction({
                    on: stakingMaster.address,
                    success: true,
                });
            }

            const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(18)));
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });

            blockchain.now = 1600000000 + 86400 * 7 + 86400 * 7;

            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7') * 10n + toNano('0.001') * BigInt(86400 * 7) * 10n);
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(9);

            for (let i = 9; i < 18; i++) {
                const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(i)));
                const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
                const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
                expect(result.transactions).toHaveTransaction({
                    on: stakingMaster.address,
                    success: true,
                });
            }

            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7') * 10n + toNano('0.001') * BigInt(86400 * 7) * 10n + toNano('7') * 9n);
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should not stake items (valid until)', async () => {
        {
            blockchain.now = 1800000001;
            let item = blockchain.openContract(await collection.getNftItemByIndex(0n));

            let result = await item.sendTransfer(
                users[0].getSender(),
                toNano('0.4'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );

            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);

            result = await stakingMaster.sendAdminChangeValidUntil(
                users[0].getSender(),
                toNano('0.05'),
                123n,
                1800000010n
            );

            item = blockchain.openContract(await collection.getNftItemByIndex(1n));

            result = await item.sendTransfer(
                users[0].getSender(),
                toNano('0.4'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );

            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(1);
        }
    });

    it('should claim rewards with boost (11 nft)', async () => {
        {
            for (let i = 9; i <= 19; i++) {
                const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(i)));
                await item.sendTransfer(
                    users[0].getSender(),
                    toNano('0.2'),
                    stakingMaster.address,
                    beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                    toNano('0.15')
                );
            }

            blockchain.now = 1600000000 + 86400 * 7;

            const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(9)));
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });

            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7') + toNano('0.001') * BigInt(86400 * 7) * 11n);
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(10);

            blockchain.now = 1600000000 + 86400 * 7 + 86400 * 7;

            for (let i = 10; i <= 19; i++) {
                const item = blockchain.openContract(await collection.getNftItemByIndex(BigInt(i)));
                const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
                const result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
                expect(result.transactions).toHaveTransaction({
                    on: stakingMaster.address,
                    success: true,
                });
            }

            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(
                toNano('7') +
                    toNano('0.001') * BigInt(86400 * 7) * 11n +
                    toNano('7') * 10n +
                    toNano('0.001') * BigInt(86400 * 7) * 10n
            );
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);
        }
    });

    it('should change valid until by admin', async () => {
        {
            expect((await stakingMaster.getContractData()).validUntil).toEqual(1800000000n);

            await stakingMaster.sendAdminChangeValidUntil(users[0].getSender(), toNano('0.05'), 123n, 1800000010n);

            expect((await stakingMaster.getContractData()).validUntil).toEqual(1800000010n);
        }
    });

    it('should change rarity by admin', async () => {
        {
            await stakingMaster.sendAdminRemoveRarity(
                users[0].getSender(),
                toNano('0.05'),
                123n,
                (
                    await stakingMaster.getContractData()
                ).rarity
            );

            expect((await stakingMaster.getContractData()).rarity.keys.length).toEqual(0);

            let rarities = Dictionary.empty(Dictionary.Keys.BigUint(16), createRewardValue());
            rarities.set(123n, {
                boostReward: toNano('0.001'),
                commonReward: toNano('0.001'),
            });
            await stakingMaster.sendAdminAddRarity(users[0].getSender(), toNano('0.05'), 123n, rarities);

            expect((await stakingMaster.getContractData()).rarity).toEqualDict(rarities);
        }
    });

    it('should process admin fees correctly', async () => {
        {
            const item = blockchain.openContract(await collection.getNftItemByIndex(0n));
            let result = await item.sendTransfer(
                users[0].getSender(),
                toNano('0.2'),
                stakingMaster.address,
                beginCell().storeUint(0x429c67c7, 32).storeUint(7, 8).endCell(),
                toNano('0.15')
            );
            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.1'),
            });
            const helper = blockchain.openContract(await stakingMaster.getHelper(item.address));
            expect(await helper.getStakedAt()).toEqual(1600000000);
            expect(await helper.getOption()).toEqual(7);
            expect(
                (
                    await stakingMaster.getItemsStakedByUser(
                        users[0].address,
                        (
                            await stakingMaster.getContractData()
                        ).stakedItems
                    )
                )[0]
            ).toEqualAddress(item.address);

            blockchain.now = 1600000000 + 86400 * 7;

            result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, false);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(stakingMaster.address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('7'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(1);

            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.1'),
            });

            blockchain.now = 1600000000 + 86400 * 14;

            result = await helper.sendClaim(users[0].getSender(), toNano('0.5'), 123n, true);
            expect(result.transactions).toHaveTransaction({
                on: stakingMaster.address,
                success: true,
            });
            expect(await item.getOwner()).toEqualAddress(users[0].address);
            expect(
                await blockchain
                    .openContract(
                        JettonWallet.createFromAddress(await jettonMinter.getWalletAddressOf(users[0].address))
                    )
                    .getJettonBalance()
            ).toEqual(toNano('14'));
            expect((await stakingMaster.getContractData()).stakedItems.keys()).toHaveLength(0);

            expect(result.transactions).toHaveTransaction({
                from: stakingMaster.address,
                to: users[0].address,
                value: toNano('0.3'),
            });
        }
    });
});
