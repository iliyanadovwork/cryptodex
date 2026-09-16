import { useEffect, useContext, useState } from 'react'
import { Container, Row, Col, Tabs, Tab, } from 'react-bootstrap';
import Link from "next/link";
import styles from '@/styles/common.module.css';
import Image from 'next/image'
//import lib
import isEmpty from '@/lib/isEmpty'
import { toFixedDown } from '@/lib/roundOf';
//improt context
import SocketContext from "../Context/SocketContext";
import { useRouter } from 'next/router';

export default function PairTable({ pairList }: any) {
    const router = useRouter()
    const socketContext = useContext<any>(SocketContext);
    const [data, setData] = useState<any>([])
    const [secondCurrencyList, setsecondCurrencyList] = useState<any>([]);

    const secondCurrencyArray = (pairList: any) => {
        let uniqueChars: any = [];
        setData(pairList)
        pairList.forEach((c: any) => {
            if (!uniqueChars.includes(c.secondCurrencySymbol)) {
                uniqueChars.push(c.secondCurrencySymbol);
            }

        });
        setsecondCurrencyList(uniqueChars);
    };

    useEffect(() => {
        if (isEmpty(data)) {
            secondCurrencyArray(pairList)
        }
        // socket
        socketContext.spotSocket.on('marketPrice', (result: any) => {
            let tempPairList = [...data];
            let pairIndex = tempPairList && tempPairList.findIndex((el: any) => {
                return el._id == result.pairId;
            })
            if (pairIndex >= 0 && !isEmpty(pairIndex)) {
                tempPairList[pairIndex] = {
                    ...tempPairList[pairIndex],
                    ...{
                        'markPrice': result.data.markPrice,
                        'change': result.data.change
                    }
                }
                setData(tempPairList)
            }
        })
    }, [data])

    useEffect(() => {
        socketContext.spotSocket.emit('subscribe', 'spot')
        return () => {
            socketContext.spotSocket.off("marketPrice");
            socketContext.spotSocket.emit('unSubscribe', 'spot')
        }
    }, [])

    return (
        <Container>
            <div className={`${styles.head} text-start ms-0 w-50 pb-3`} data-aos="fade-up" data-aos-duration="1000"  >
                <h2 className={styles.h2tag} >Trending Crypto Pairs</h2>
                <p className='mb-0'>Buy and sell 250+ cryptocurrencies with 20+ fiat currencies using bank transfers or your credit/debit card.</p>
            </div>
            <div className='tabs' >
                <Tabs defaultActiveKey={data[0]?.secondCurrencySymbol} id="trending-pairs"   >
                    {
                        secondCurrencyList?.length > 0 && secondCurrencyList.map((tab: any, index: number) => {
                            return (
                                <Tab eventKey={tab} title={tab}  >
                                    <Row>
                                        {
                                            data?.length > 0 && data.slice(0, 4).map((item: any, index: number) => {
                                                if (tab == item.secondCurrencySymbol) {
                                                    return (
                                                        <Col className='d-flex' sm={6} md={6} lg={3} data-aos="flip-up" data-aos-duration="1000">
                                                            <div className={`w-100 ${styles.box}`}>
                                                                <div className={styles.flx}>
                                                                    <div className={`${styles.images}`}>
                                                                        {
                                                                            item.firstCurrencyImage && <Image src={item.firstCurrencyImage} alt="image" className={`${styles.right_icon} img-fluid`} width={27} height={27} />
                                                                        }
                                                                        {
                                                                            item.secondCurrencyImage && <Image src={item.secondCurrencyImage} alt="image" className={` ${styles.left_icon} img-fluid`} width={27} height={27} />
                                                                        }

                                                                    </div>
                                                                    <p><span>{item.firstCurrencySymbol} </span> - <span>{item.secondCurrencySymbol}</span></p>
                                                                </div>

                                                                <h6>${item.markPrice}</h6>
                                                                <div className={styles.info}>
                                                                    <div>
                                                                        <p className={item?.change < 0 ? 'text-danger' : ''}>{!isEmpty(item?.change) ? toFixedDown(item.change, 2) : 0}%</p>
                                                                        <span>24H Change</span>
                                                                    </div>
                                                                    <div>
                                                                        <p>${toFixedDown(item.secondVolume, 2)}</p>
                                                                        <span>24H Volume</span>
                                                                    </div>
                                                                </div>
                                                                <Link href="#" className={styles.trade} onClick={() => router.push(`/spot/${item.firstCurrencySymbol}_${item.secondCurrencySymbol}`)}>Trade</Link>

                                                            </div>
                                                        </Col>
                                                    )
                                                }
                                            })
                                        }

                                    </Row>
                                </Tab>
                            )
                        })
                    }
                </Tabs>
            </div>
        </Container>
    )
}