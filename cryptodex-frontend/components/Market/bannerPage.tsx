// import { useEffect, useContext, useState } from "react";
// import { Container, Table } from "react-bootstrap";
// import styles from "@/styles/common.module.css";
// import Image from "next/image";
// //import lib
// import isEmpty from "@/lib/isEmpty";
// import { toFixed } from "@/lib/roundOf";
// //improt context
// import SocketContext from "../Context/SocketContext";
// import { useRouter } from "next/router";
// import { apigetPairList } from "@/services/Spot/SpotService";
// import { nWComma } from "@/lib/calculation";

// import Slider from "react-slick";


// export default function MarketPageTable({ pairList }: any) {
//     const settings = {
//         dots: false,
//         infinite: true, // Ensures it loops
//         speed: 500, // Speed of the transition (in ms)
//         slidesToShow: 5, // Number of items to show in the viewport
//         slidesToScroll: 1, // How many items to scroll per swipe
//         autoplay: true, // Enable auto-moving
//         autoplaySpeed: 3000, // Time between scrolls (3 seconds)
//         arrows: false, // Disable the next/prev arrows
//     };

//     const router = useRouter();
//     const socketContext = useContext<any>(SocketContext);
//     const [data, setData] = useState<any>([]);

//     // useEffect(() => {
//     //     if (isEmpty(data)) {
//     //         setData(pairList)
//     //     }
//     // }, [data])

//     useEffect(() => {
//         fetchPairList();
//     }, []);
//     const fetchPairList = async () => {
//         if (isEmpty(data)) {
//             const data: any = await apigetPairList();
//             let pList = data?.data?.result
//             const result = pList
//                 .filter((item: any) => item.botstatus === 'off')
//                 .sort((a: any, b: any) => b.secondVolume - a.secondVolume);
//             setData(result);
//         }
//     };

//     useEffect(() => {
//         // socket
//         socketContext.spotSocket.on("marketPrice", (result: any) => {
//             console.log(result, "-------result");
//             let tempPairList = [...data];
//             let pairIndex =
//                 tempPairList &&
//                 tempPairList.findIndex((el: any) => {
//                     return el._id == result.pairId;
//                 });
//             if (pairIndex >= 0 && !isEmpty(pairIndex)) {
//                 tempPairList[pairIndex] = {
//                     ...tempPairList[pairIndex],
//                     ...{
//                         markPrice: result.data.markPrice,
//                         change: result.data.change,
//                         last: result.data.last,
//                     },
//                 };
//                 setData(tempPairList);
//             }
//         });
//         // return () => {
//         //     socketContext.spotSocket.off("marketPrice");
//         // }
//     }, [data]);
//     console.log(data, '------87')
//     useEffect(() => {
//         socketContext.spotSocket.emit("subscribe", "spot");
//         return () => {
//             socketContext.spotSocket.off("marketPrice");
//             socketContext.spotSocket.emit("unSubscribe", "spot");
//         };
//     }, []);
//     return (
//         <Container>
//             <div className='slider' >
//                 <Slider {...settings}>
//                     {data.map((item: any, index: any) => (
//                         <div key={index} className={styles.crypto_item}>
//                             <div className={styles.crypto_pair}>
//                                 <Image src={item.firstCurrencyImage} alt={item.tikerRoot} width={30} height={30} />
//                                 <span>{item.tikerRoot}</span>
//                             </div>
//                             <div className={`${styles.crypto_price} green`}>
//                                 {`Price: ${toFixed(item.markPrice, item.secondFloatDigit)}`}
//                             </div>
//                             <div className={`${styles.crypto_price} green`}>
//                                 {`Change: ${toFixed(item.change, item.secondFloatDigit)}`}
//                             </div>
//                         </div>
//                     ))}
//                 </Slider>
//             </div>
//         </Container>
//     );
// }







import { apigetPairList } from '@/services/Spot/SpotService';
import React, { useEffect, useState, useRef } from 'react';

export default function BannerPage() {
    const [symbols, setSymbols] = useState<any[]>([]);
    const [isClient, setIsClient] = useState(false);
    const widgetRef = useRef<HTMLDivElement>(null);
    const scriptAddedRef = useRef(false);

    useEffect(() => {
        setIsClient(true);
        fetchPairList();
    }, []);

    const fetchPairList = async () => {
        try {
            const data: any = await apigetPairList();
            let pList = data?.data?.result || [];
            let symbol: any[] = [];

            // Get top USDT pairs by volume (limit to 10)
            const topPairs = pList
                .filter((item: any) => item.secondCurrencySymbol === 'USDT')
                .sort((a: any, b: any) => (b.secondVolume || 0) - (a.secondVolume || 0))
                .slice(0, 10);

            // Create symbol list for TradingView widget
            for (let item of topPairs) {
                symbol.push({
                    proName: "BINANCE:" + item.firstCurrencySymbol + "USDT"
                });
            }
            setSymbols(symbol);
        } catch (err) {
            console.error("Error fetching pair list:", err);
        }
    };

    useEffect(() => {
        if (!isClient || symbols.length === 0 || scriptAddedRef.current) return;

        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
        script.async = true;
        script.type = 'text/javascript';
        script.innerHTML = JSON.stringify({
            symbols: symbols,
            showSymbolLogo: true,
            isTransparent: true,
            displayMode: 'compact',
            colorTheme: 'dark',
            width: '100%',
            height: 72,
            locale: 'en',
        });

        const container = widgetRef.current;
        if (container) {
            container.innerHTML = ''; // Clear any existing content
            container.appendChild(script);
            scriptAddedRef.current = true;
        }

        return () => {
            if (container) {
                container.innerHTML = '';
            }
            scriptAddedRef.current = false;
        };
    }, [symbols, isClient]);

    if (!isClient) {
        return (
            <div className="tradingview-widget-container" style={{ width: '100%', height: '72px' }} />
        );
    }

    return (
        <div
            ref={widgetRef}
            className="tradingview-widget-container"
            id="tradingview-widget-container"
            style={{ width: '100%', height: '72px' }}
        />
    );
}