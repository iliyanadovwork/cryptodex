import styles from '@/styles/common.module.css';
import { Table } from 'react-bootstrap';
import { useState, useEffect } from 'react';
//improt lib
import dynamic from 'next/dynamic'
import { dateTimeFormat } from '@/lib/dateTimeHelper';
import { transactionStatus } from '@/lib/displayStatus';
import { capitalize } from '@/lib/stringCase';
import isEmpty from '@/lib/isEmpty'
// import service
import { apiGetTrnxHistory } from '@/services/Wallet/WalletService'
import { useTheme } from 'next-themes';
import Image from 'next/image';
//import component
const Pagination = dynamic(() => import('@/lib/pagination'), { ssr: false });

const spinner: React.CSSProperties = {
    fontSize: '36px',
};

export default function TransactionHist({ type }: any) {
    // state
    const [loader, setLoader] = useState<boolean>(false)
    const [record, setRecord] = useState<any>({ 'data': [], 'count': 0 })
    const [filter, setFilter] = useState<any>({
        'coin': 'all',
        'paymentType': type,
        'search': '',
        'page': 1,
        'limit': 5
    })
    const [currentPage, setCurrentPage] = useState(1);
    const { theme, setTheme } = useTheme();
    // function
    const fetchCryptoHistory = async (reqQuery: any) => {
        try {
            setLoader(true)
            const respData: any = await apiGetTrnxHistory('crypto', reqQuery)
            setLoader(false)
            if (respData && respData.data.result.count && respData.data.result.count > 0) {
                const result = respData.data.result;
                let resultArr: any[] = []
                result.data.map((item: any) => {
                    resultArr.push({
                        'date': dateTimeFormat(item.createdAt, 'YYYY-MM-DD HH:mm'),
                        'type': transactionStatus(item.paymentType),
                        'currency': item.coin,
                        'amount': item.amount,
                        'txid': !isEmpty(item.txid) ? item.txid : '-',
                        'tokenType': item.tokenType == null ? "" : item.tokenType == undefined ? "" : item.tokenType,
                        'status': <div className="textStatusGreen">{capitalize(item.status)}</div>
                    })
                })
                setRecord({
                    'data': resultArr,
                    count: result.count
                })
                return;
            }
            setRecord({
                'data': [],
                count: 0
            })
        } catch (err) {
            setLoader(false)
            setRecord({
                'data': [],
                'count': 0
            })
        }
    }

    useEffect(() => {
        fetchCryptoHistory(filter)
    }, [filter])

    useEffect(() => {
        setFilter({ ...filter, page: currentPage })
        setLoader(true)
    }, [currentPage])

    return (
        <div className={`mb-3 ${styles.table_box} pt-0`}>


            <Table responsive borderless>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Type </th>
                        <th>Currency</th>
                        <th>Amount</th>
                        <th>Transaction Ref</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {
                        loader ?
                            <tr>
                                <td></td>
                                <td></td>
                                <td></td>
                                <td colSpan={9}   >
                                    <i className="fa fa-spinner fa-spin" style={spinner} ></i>
                                </td>
                            </tr> :
                            record?.data?.length > 0 ? record.data.map((item: any, key: number) => {
                                return (
                                    <tr key={key}>
                                        <td>{item.date}</td>
                                        <td>{item.type}</td>
                                        <td>{item.currency}</td>
                                        <td>{item.amount}</td>
                                        <td>{item.txid}</td>
                                        <td>
                                            {item.status}
                                        </td>
                                    </tr>
                                );
                            }) :
                                <tr>
                                    <td colSpan={12}>
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
                                            <h6>No Records Found</h6>
                                        </div>
                                    </td>
                                </tr>
                    }
                </tbody>
            </Table>
            {
                record?.count > 0 &&
                <Pagination
                    currentPage={currentPage}
                    totalCount={record.count}
                    pageSize={5}
                    onPageChange={(page: number) => setCurrentPage(page)}
                />
            }

        </div>
    )
}