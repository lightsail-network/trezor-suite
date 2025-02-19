import { A, D, G, pipe } from '@mobily/ts-belt';
import BigNumber from 'bignumber.js';
import { fromUnixTime, getUnixTime } from 'date-fns';

import { FiatCurrencyCode } from '@suite-common/suite-config';
import { NetworkSymbol, getNetworkType } from '@suite-common/wallet-config';
import { formatNetworkAmount } from '@suite-common/wallet-utils';
import { AccountBalanceHistory as AccountMovementHistory } from '@trezor/blockchain-link';
import TrezorConnect from '@trezor/connect';
import { getFiatRatesForTimestamps } from '@suite-common/fiat-services';
import {
    AccountBalanceHistory,
    TransactionCacheEngine,
} from '@suite-common/transaction-cache-engine';

import { NUMBER_OF_POINTS } from './constants';
import {
    AccountHistoryBalancePoint,
    findOldestBalanceMovementTimestamp,
    getTimestampsInTimeFrame,
    mapCryptoBalanceMovementToFixedTimeFrame,
    mergeMultipleFiatBalanceHistories,
} from './graphUtils';
import { AccountItem, FiatGraphPoint, FiatGraphPointWithCryptoBalance } from './types';

export const addBalanceForAccountMovementHistory = (
    data: AccountMovementHistory[] | AccountBalanceHistory[],
    symbol: NetworkSymbol,
): AccountHistoryBalancePoint[] => {
    let balance = new BigNumber('0');
    const historyWithBalance = data.map(dataPoint => {
        // subtract sentToSelf field as we don't want to include amounts received/sent to the same account
        const normalizedReceived = dataPoint.sentToSelf
            ? new BigNumber(dataPoint.received).minus(dataPoint.sentToSelf || 0)
            : dataPoint.received;
        const normalizedSent = dataPoint.sentToSelf
            ? new BigNumber(dataPoint.sent).minus(dataPoint.sentToSelf || 0)
            : dataPoint.sent;

        balance = new BigNumber(balance).plus(normalizedReceived).minus(normalizedSent);

        return {
            time: dataPoint.time,
            cryptoBalance: formatNetworkAmount(balance.toFixed(), symbol),
        };
    });

    return historyWithBalance;
};

const getLatestAccountBalance = async ({
    coin,
    identity,
    descriptor,
}: {
    coin: NetworkSymbol;
    identity?: string;
    descriptor: string;
}) => {
    const networkType = getNetworkType(coin);

    const accountInfo = await TrezorConnect.getAccountInfo({
        coin,
        identity,
        descriptor,
        suppressBackupWarning: true,
    });

    if (!accountInfo?.success) {
        throw new Error(`Get account balance info error: ${accountInfo.payload.error}`);
    }

    switch (networkType) {
        case 'ripple':
            // On Ripple, if we use availableBalance, we will get higher balance, IDK why.
            return accountInfo.payload.balance;
        default:
            return accountInfo.payload.availableBalance;
    }
};

const accountBalanceHistoryCache: Record<string, AccountHistoryBalancePoint[]> = {};

const getAccountBalanceHistory = async ({
    coin,
    identity,
    descriptor,
    endOfTimeFrameDate,
    forceRefetch,
}: {
    coin: NetworkSymbol;
    identity?: string;
    descriptor: string;
    endOfTimeFrameDate: Date;
    forceRefetch?: boolean;
}): Promise<AccountHistoryBalancePoint[]> => {
    const endTimeFrameTimestamp = getUnixTime(endOfTimeFrameDate);
    const cacheKey = `${coin}-${descriptor}-${endTimeFrameTimestamp}`;

    if (accountBalanceHistoryCache[cacheKey] && !forceRefetch) {
        return accountBalanceHistoryCache[cacheKey];
    }

    const getBalanceHistory = async () => {
        if (getNetworkType(coin) === 'ripple') {
            return TransactionCacheEngine.getAccountBalanceHistory({
                coin,
                descriptor,
            });
        }
        const connectBalanceHistory = await TrezorConnect.blockchainGetAccountBalanceHistory({
            coin,
            identity,
            descriptor,
            to: endTimeFrameTimestamp,
            groupBy: 1,
            // we don't need currencies at all here, this will just reduce transferred data size
            // TODO: doesn't work at all, fix it in connect or blockchain-link?
            // issue: https://github.com/trezor/trezor-suite/issues/8888
            currencies: ['usd'],
        });

        if (!connectBalanceHistory?.success) {
            throw new Error(
                `Get account balance movement error: ${connectBalanceHistory.payload.error}`,
            );
        }

        return connectBalanceHistory.payload;
    };

    const [accountMovementHistory, latestAccountBalance] = await Promise.all([
        getBalanceHistory(),
        getLatestAccountBalance({ coin, identity, descriptor }),
    ]);

    const accountMovementHistoryWithBalance = addBalanceForAccountMovementHistory(
        accountMovementHistory,
        coin,
    );

    // Last point must be balance from getAccountInfo because blockchainGetAccountBalanceHistory it's not always reliable for coins like ETH.
    // TODO: We can get value from Transaction Cache engine instead of fetching it again?
    accountMovementHistoryWithBalance.push({
        time: endTimeFrameTimestamp,
        cryptoBalance: formatNetworkAmount(latestAccountBalance, coin),
    });

    accountBalanceHistoryCache[cacheKey] = accountMovementHistoryWithBalance;

    return accountMovementHistoryWithBalance;
};

type FiatRatesItem = {
    time: number;
    rates: {
        [key: string]: number | undefined;
    };
};

const fiatRatesCache: Record<string, FiatRatesItem[]> = {};

export const getFiatRatesForNetworkInTimeFrame = async ({
    timestamps,
    coin,
    fiatCurrency,
    forceRefetch,
    isElectrumBackend,
}: {
    timestamps: number[];
    coin: NetworkSymbol;
    fiatCurrency: FiatCurrencyCode;
    forceRefetch?: boolean;
    isElectrumBackend: boolean;
}) => {
    const cacheKey = `${coin}-${fiatCurrency}-${JSON.stringify(timestamps)}`;

    if (fiatRatesCache[cacheKey] && !forceRefetch) {
        return fiatRatesCache[cacheKey];
    }

    const fiatRates = await getFiatRatesForTimestamps(
        { symbol: coin },
        timestamps,
        fiatCurrency,
        isElectrumBackend,
    );
    if (G.isNullable(fiatRates)) return null;

    const formattedFiatRates = fiatRates.tickers.map((ticker, index) => ({
        time: timestamps[index],
        rates: ticker.rates,
    }));

    fiatRatesCache[cacheKey] = formattedFiatRates;

    return formattedFiatRates;
};

export const getMultipleAccountBalanceHistoryWithFiat = async ({
    accounts,
    startOfTimeFrameDate,
    endOfTimeFrameDate,
    numberOfPoints = NUMBER_OF_POINTS,
    fiatCurrency,
    forceRefetch,
    isElectrumBackend,
}: {
    accounts: AccountItem[];
    startOfTimeFrameDate: Date | null;
    endOfTimeFrameDate: Date;
    numberOfPoints?: number;
    fiatCurrency: FiatCurrencyCode;
    forceRefetch?: boolean;
    isElectrumBackend: boolean;
}): Promise<FiatGraphPoint[] | FiatGraphPointWithCryptoBalance[]> => {
    const accountsWithBalanceHistory = await Promise.all(
        accounts.map(({ coin, descriptor, identity }) =>
            getAccountBalanceHistory({
                coin,
                descriptor,
                identity,
                endOfTimeFrameDate,
                forceRefetch,
            })
                .then(balanceHistory => ({
                    coin,
                    descriptor,
                    balanceHistory,
                }))
                .catch(error => {
                    console.error(
                        `Unable to fetch GRAPH balance history for ${coin} account:`,
                        error,
                    );
                    error.message = `${coin.toUpperCase()}: ${error.message}`;
                    throw error;
                }),
        ),
    );

    if (!startOfTimeFrameDate) {
        // if startOfTimeFrameDate is not provided, it means we want to show all available data
        // so we need to find the oldest date balance movement in all accounts
        startOfTimeFrameDate = pipe(
            accountsWithBalanceHistory,
            findOldestBalanceMovementTimestamp,
            fromUnixTime,
        );
    }

    // Last timestamp must be endOfTimeFrameDate because blockchainGetAccountBalanceHistory it's not always reliable for coins like ETH.
    // So we manually add balance from getAccountInfo for last point in getAccountBalanceHistory.
    const timestamps = [
        ...getTimestampsInTimeFrame(startOfTimeFrameDate, endOfTimeFrameDate, numberOfPoints - 1),
        getUnixTime(endOfTimeFrameDate),
    ];

    const coins = pipe(
        accounts,
        A.map(({ coin }) => coin),
        A.uniq,
    );

    const coinsFiatRates = D.fromPairs(
        await Promise.all(
            coins.map(coin =>
                getFiatRatesForNetworkInTimeFrame({
                    timestamps,
                    coin,
                    fiatCurrency,
                    forceRefetch,
                    isElectrumBackend,
                })
                    .then(res => {
                        if (res === null)
                            throw new Error(`Unable to fetch fiat rates for defined timestamps.`);

                        return [coin, res] as const;
                    })
                    .catch(error => {
                        console.error(
                            `Unable to fetch GRAPH fiat rates ${fiatCurrency} for ${coin}:`,
                            error,
                        );
                        error.message = `${coin.toUpperCase()} (${fiatCurrency}): ${error.message}`;
                        throw error;
                    }),
            ),
        ),
    );

    if (A.length(accountsWithBalanceHistory) === 1) {
        // If there is only one account, we don't need to merge anything.
        // We can also keep cryptoBalance in points.
        const { coin, balanceHistory } = A.head(accountsWithBalanceHistory)!;

        return mapCryptoBalanceMovementToFixedTimeFrame({
            fiatRates: coinsFiatRates[coin],
            fiatCurrency,
            balanceHistory,
        }) as FiatGraphPointWithCryptoBalance[];
    }

    const accountsWithFiatBalanceHistory = A.map(
        accountsWithBalanceHistory,
        ({ coin, balanceHistory }) => {
            const coinFiatRates = coinsFiatRates[coin];

            return mapCryptoBalanceMovementToFixedTimeFrame({
                fiatRates: coinFiatRates,
                fiatCurrency,
                balanceHistory,
            });
        },
    );

    return mergeMultipleFiatBalanceHistories(accountsWithFiatBalanceHistory) as FiatGraphPoint[];
};
