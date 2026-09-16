import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
    Table
} from 'react-bootstrap';
// import service
import { getDemoCreditHistory } from '../../services/Wallet/WalletService'
//import lib
import { dateTimeFormat } from '../../lib/dateTimeHelper';
import { useTheme } from 'next-themes';
import Image from 'next/image';
//import component
const Pagination = dynamic(() => import('../../lib/pagination'), { ssr: false });

/**
 * THE WHOLE CLAIM, NOT ITS SPOT HALF - FROM THE SERVER
 * ====================================================
 *
 * A faucet claim once credited more than one wallet. The
 * spot legs were the only ones the server recorded, so this table showed
 * 1,000 USDC + 1,000 USD and said nothing about the 0.05 BTC + 1 ETH +
 * 50 SOL credited in the same call.
 *
 * It used to paper over that here, by joining a receipt kept in THIS browser's
 * localStorage back onto the server rows. That is not history: it existed only
 * on the device that made the claim, and vanished with the storage. The legs
 * are persisted at source now (spotapi controllers/faucet.controller.js
 * recordCreditedLegs), each row carrying the wallet it landed in, so this
 * component renders exactly what the API returned and reconstructs nothing.
 *
 * AND FOR A WHILE IT RENDERED NOTHING AT ALL. The endpoint this reads,
 * `spot/getDepositHistory`, was deleted from spotapi along with the real
 * deposit rails - but the rows never stopped being written, because they are
 * written by the FAUCET. So the request 404'd, the catch below turned that into
 * an empty result, and both places this table appears (the claim page and
 * /history's Demo Credits tab) printed "No Records Found" to users who had just
 * claimed. The route is back as `spot/faucet/history` and this reads it through
 * `getDemoCreditHistory`.
 *
 * The catch is deliberately still quiet in the UI, but it now logs; an empty
 * table and a failed request must never again be indistinguishable to whoever
 * is looking at the console.
 */

interface DepositHistoryProps {
    /** Bumped by the claim page after a successful claim, to refetch. */
    refreshKey?: number;
}

export default function DepositHistory({ refreshKey = 0 }: DepositHistoryProps) {
    // state
    const [currentPage, setCurrentPage] = useState(1);
    const [count, setCount] = useState(0);
    const [record, setRecord] = useState<any>({ 'data': [], 'count': 0 })
    const { theme } = useTheme();

    const fetchDepositHistory = async (page: number) => {
        try {
            const respData: any = await getDemoCreditHistory(page, 5);

            if (respData && respData.data.success && respData.data.result) {
                const result = respData.data.result;
                setCount(result.count || 0);
                let resultArr: any[] = []
                if (result.data && result.data.length > 0) {
                    result.data.map((item: any) => {
                        resultArr.push({
                            'date': dateTimeFormat(item.createdAt, 'YYYY-MM-DD HH:mm'),
                            // The row says which wallet it landed in; rows that
                            // predate the column report 'spot', which is what
                            // every one of them was.
                            'currency': item.coin,
                            'amount': item.amount,
                            'signature': item.txid,
                        })
                    })
                }
                setRecord({
                    'data': resultArr,
                    count: result.count || 0
                })
                return;
            }
            setRecord({
                'data': [],
                count: 0
            })
        } catch (err) {
            console.error('Deposit history error:', err);
            setRecord({
                'data': [],
                count: 0
            })
        }
    }

    // Refetch on a page change, and after a claim, so the rows the claim
    // created show up without a manual reload.
    useEffect(() => {
        fetchDepositHistory(currentPage)
    }, [currentPage, refreshKey])

    // The server's rows, as they came. No local reconstruction: a leg that is
    // not in the response is a leg the server did not record, and inventing it
    // here would only hide that from the one device able to notice.
    const rows: any[] = record?.data || [];

    return (
        <>
            <Table responsive  >
                <thead>
                    <tr>
                        {/* FOUR COLUMNS SAID THE SAME THING ON EVERY ROW.
                            Type was the literal 'Demo credit', written in this
                            file rather than read from anything. Wallet was
                            always "Spot wallet" - this venue has one. Status was
                            always "Completed": the faucet writes 'credited' and
                            nothing else ever sets it. And the reference was one
                            the faucet builds from a timestamp and a user id,
                            truncated to 16 characters, with no explorer to look
                            it up in and no support desk to quote it to.
                            Currency stays. It is constant while the faucet
                            grants one coin, but it is the column that begins
                            varying the day it grants two, and the empty state
                            already promises "one row per coin". */}
                        <th>Date &amp; Time</th>
                        <th className='text-start'> Currency </th>
                        <th> Amount </th>
                    </tr>
                </thead>
                <tbody>
                    {
                        rows.length > 0 ? (
                            rows.map((item: any, index: number) => {
                                return (
                                    <tr key={item.signature || index}>
                                        <td>{item.date}</td>
                                        <td>{item.currency}</td>
                                        <td>{item.amount}</td>
                                    </tr>
                                );
                            })
                        ) : (
                            <tr>
                                <td colSpan={3}>
                                    <div className="d-flex flex-column gap-3 align-items-center m-5">
                                        {theme === "light_theme" ? (
                                            <Image
                                                src="/assets/images/nodata_light.svg"
                                                alt="No data"
                                                className="img-fluid"
                                                width={96}
                                                height={96}
                                            />
                                        ) : (
                                            <Image
                                                src="/assets/images/nodata.svg"
                                                alt="No data"
                                                className="img-fluid"
                                                width={96}
                                                height={96}
                                            />
                                        )}
                                        {/* WHY AN ACCOUNT CAN HOLD 2,000 AND
                                            HAVE NO ROWS HERE. The balance a new
                                            account starts with is written by
                                            walletapi when the wallet is created
                                            (controllers/createAsset.js), not by
                                            the faucet, so no deposit row is
                                            recorded for it. This table lists
                                            CLAIMS. "No Records Found" over a
                                            funded wallet reads as a table that
                                            failed to load - which is exactly
                                            what it WAS, for as long as the
                                            route behind it was deleted - so it
                                            says which of the two it is. */}
                                        <h6>No claims yet</h6>
                                        <span className="text-muted">
                                            Every faucet claim is listed here,
                                            one row per coin. The balance your
                                            account started with was seeded when
                                            it was created, and is not a claim.
                                        </span>
                                    </div>
                                </td>
                            </tr>
                        )
                    }
                </tbody>

            </Table>
            <Pagination
                currentPage={currentPage}
                totalCount={count}
                pageSize={5}
                onPageChange={(page: number) => setCurrentPage(page)}
            />
        </>
    )
}
