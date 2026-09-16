import { useEffect, useContext, useState } from "react";
import styles from "@/styles/common.module.css";
import Image from "next/image";
import Link from "next/link";
import { Container, InputGroup, Table, Form, Row, Col } from "react-bootstrap";
//import lib
import isEmpty from "@/lib/isEmpty";
import { toFixed } from "@/lib/roundOf";
//improt context
import SocketContext from "../Context/SocketContext";
//improt store
import { useSelector } from "../../store";
import { nWComma } from "@/lib/calculation";

export default function MarketPageTable({ pairList }: any) {
  const [usdtValue, setusdValue] = useState<any>();
  const socketContext = useContext<any>(SocketContext);
  const [data, setData] = useState<any>([]);
  const [secondCurrencyList, setsecondCurrencyList] = useState<any>([]);
  const [selectCurr, setSelectCurr] = useState<string>("");
  const [selectTabCurr, setSelectTabCurr] = useState<string>("");
  const [search, setSearch] = useState<boolean>(false);
  const { priceConversion } = useSelector((state: any) => state.wallet);

  const handleTabClick = (tabid: any) => {
    setSelectCurr(tabid);
    setSearch(false);
    setSelectTabCurr(tabid);
  };

  const secondCurrencyArray = (pairList: any) => {
    let uniqueChars: any = [];
    pairList.forEach((c: any) => {
      if (!uniqueChars.includes(c.secondCurrencySymbol)) {
        uniqueChars.push(c.secondCurrencySymbol);
      }
    });
    setsecondCurrencyList(uniqueChars);

    setSelectTabCurr(uniqueChars[0]);
    setSelectCurr(uniqueChars[0]);
  };
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    let { value } = e.target;
    if (isEmpty(value)) {
      setSearch(false);
      setSelectCurr(secondCurrencyList[0]);
      setSelectTabCurr(secondCurrencyList[0]);
    } else {
      setSearch(true);
      setSelectCurr(value);
    }
  };

  const getPairData = (pairList: any) => {
    let newArr: any = [];
    pairList?.length > 0 &&
      pairList.map((item: any) => {
        let usdtValue;
        if (item.secondCurrencySymbol == "USDT") {
          usdtValue = item.markPrice;
        } else {
          let MarkValue = priceConversion.find(
            (elem: any) =>
              elem.baseSymbol == item.secondCurrencySymbol &&
              elem.convertSymbol == "USDT"
          );
          if (MarkValue) {
            usdtValue = item.markPrice * MarkValue.convertPrice;
          } else {
            usdtValue = item.markPrice;
          }
        }
        newArr.push({ ...item, ...{ usdtValue } });
      });
    newArr = newArr.sort((a: any, b: any) => b.secondVolume - a.secondVolume);
    setData(newArr);
  };

  useEffect(() => {
    if (isEmpty(data)) {
      getPairData(pairList);
      secondCurrencyArray(pairList);
    }
  }, [data]);

  useEffect(() => {
    // socket
    socketContext.spotSocket.on("marketPrice", (result: any) => {
      let tempPairList = [...data];
      let pairIndex =
        tempPairList &&
        tempPairList.findIndex((el: any) => {
          return el._id == result.pairId;
        });
      if (pairIndex >= 0 && !isEmpty(pairIndex)) {
        let usdtValue;
        if (tempPairList[pairIndex].secondCurrencySymbol == "USDT") {
          usdtValue = result.data.markPrice;
        } else {
          let MarkValue = priceConversion.find(
            (item: any) =>
              item.baseSymbol == tempPairList[pairIndex].secondCurrencySymbol &&
              item.convertSymbol == "USDT"
          );
          if (MarkValue) {
            usdtValue = result.data.markPrice * MarkValue.convertPrice;
          } else {
            usdtValue = result.data.markPrice;
          }
        }
        tempPairList[pairIndex] = {
          ...tempPairList[pairIndex],
          ...{
            markPrice: result.data.markPrice,
            change: result.data.change,
            usdtValue,
          },
        };
        setData(tempPairList);
      }
    });
  }, [data]);

  useEffect(() => {
    socketContext.spotSocket.emit("subscribe", "spot");
    return () => {
      socketContext.spotSocket.off("marketPrice");
      socketContext.spotSocket.emit("unSubscribe", "spot");
    };
  }, []);

  return (
    <Container>
      <div className={`${styles.trending_pair}`}>
        <Row>
          {data?.length > 0 &&
            data.slice(0, 2).map((item: any, index: number) => {
              let changeCol = item.change && item.change > 0 ? "green" : "red";
              return (
                <Col className="d-flex" sm={6} md={6} lg={3} key={index}>
                  <div className={`w-100 ${styles.box} ${styles.minheight}`}>
                    <div className={styles.flx}>
                      <div className={`${styles.images}`}>
                        {!isEmpty(item.firstCurrencyImage) && (
                          <Image
                            src={item.firstCurrencyImage}
                            alt="image"
                            className={`rounded-5 ${styles.right_icon} img-fluid`}
                            width={25}
                            height={25}
                          />
                        )}{" "}
                        {!isEmpty(item.secondCurrencyImage) && (
                          <Image
                            src={item.secondCurrencyImage}
                            alt="image"
                            className={`rounded-5 ${styles.right_icon} img-fluid`}
                            width={25}
                            height={25}
                          />
                        )}
                      </div>
                      <p>
                        <span> {item.firstCurrencySymbol} </span> -{" "}
                        <span>{item.secondCurrencySymbol}</span>
                      </p>
                    </div>

                    <h6>${toFixed(item.markPrice, 2)}</h6>
                    <div className={`mb-3 ${styles.info}`}>
                      <div>
                        <p style={{ color: changeCol }}>
                          {!isEmpty(item?.change) ? toFixed(item.change, 2) : 0}
                          %
                        </p>
                        <span>24H Change</span>
                      </div>
                      <div>
                        <p>
                          $
                          {!isEmpty(item?.secondVolume)
                            ? toFixed(item.secondVolume, 2)
                            : 0}
                        </p>
                        <span>24H Volume({item.secondCurrencySymbol})</span>
                      </div>
                    </div>
                  </div>
                </Col>
              );
            })}
        </Row>
      </div>

      <div className="d-lg-flex justify-content-between  pb-2 my-4 w-100">
        <div className="tabs d-flex">
          {secondCurrencyList?.length > 0 &&
            secondCurrencyList.map((item: string, index: number) => {
              return (
                <div className="nav-item" key={index}>
                  <button
                    onClick={() => handleTabClick(item)}
                    className={`${selectTabCurr.toUpperCase() === item.toUpperCase()
                      ? "active"
                      : ""
                      }   `}
                  >
                    {item}
                  </button>
                </div>
              );
            })}
        </div>
        <div>
          <InputGroup className={`${styles.input_grp} mt-3 mt-lg-0`}>
            <Form.Control
              placeholder="Search"
              aria-label="Recipient's username"
              aria-describedby="basic-addon2"
              className={styles.text}
              onChange={handleSearch}
            />
            <InputGroup.Text id="basic-addon2" className={styles.grp_text}>
              <Image
                src="/assets/images/search.png"
                alt="image"
                className="img-fluid"
                width={25}
                height={25}
              />
            </InputGroup.Text>
          </InputGroup>
        </div>
      </div>
      <div className={`${styles.asset_table} ${styles.asset_table_chg}`}>
        <Table responsive>
          <thead>
            <tr>
              <th>Pairs</th>
              <th> Last Price </th>
              <th className="text-end"> 24h Change </th>
              <th className="text-end">24h High</th>
              <th className="text-end px-4">24h Low</th>
              <th className="text-end">24h Volume</th>
              <th className="text-end pe-4">Action</th>
            </tr>
          </thead>
          <tbody>
            {data?.length > 0 &&
              data.map((item: any, index: number) => {
                if (
                  selectCurr?.toUpperCase() ==
                  (search
                    ? item?.firstCurrencySymbol.toUpperCase()
                    : item?.secondCurrencySymbol.toUpperCase())
                ) {
                  if (
                    search &&
                    selectTabCurr.toUpperCase() ===
                    item?.secondCurrencySymbol.toUpperCase()
                  ) {
                    return (
                      <tr key={index}>
                        <td>
                          <div className="py-1">
                            {!isEmpty(item.firstCurrencyImage) && (
                              <Image
                                src={item.firstCurrencyImage}
                                alt="image"
                                className={`rounded-5 ${styles.right_icon} img-fluid`}
                                width={25}
                                height={25}
                              />
                            )}{" "}
                            <span>
                              {item.firstCurrencySymbol}/
                              {item.secondCurrencySymbol}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span className={styles.green_text}>
                            {nWComma(toFixed(item.markPrice, 2))}
                          </span>{" "}
                          <span className={styles.grey_text}>
                            / $
                            {nWComma(toFixed(
                              isEmpty(item.usdtValue)
                                ? item.markPrice
                                : item.usdtValue,
                              2
                            ))}
                          </span>
                        </td>
                        <td className="text-end">
                          <span
                            style={{ color: toFixed(item.change) > 0 ? "green" : "red" }}
                            className={
                              item.change > 0
                                ? styles.green_text
                                : styles.red_text
                            }
                          >
                            {!isEmpty(item?.change)
                              ? toFixed(item.change, 2)
                              : 0}
                            %
                          </span>
                        </td>
                        <td className="text-end">
                          {!isEmpty(item?.high) ? nWComma(toFixed(item.high, 2)) : 0}
                        </td>
                        <td className="text-end px-4">
                          {!isEmpty(item?.low) ? nWComma(toFixed(item.low, 2)) : 0}
                        </td>
                        <td className="text-end">
                          {!isEmpty(item?.secondVolume)
                            ? nWComma(toFixed(item.secondVolume, 2))
                            : 0}
                        </td>
                        <td className="text-end pe-4">
                          <Link
                            href={`/spot/${item.firstCurrencySymbol}_${item.secondCurrencySymbol}`}
                            className={`${styles.green_text} text-decoration-none`}
                          >
                            Trade
                          </Link>
                        </td>
                      </tr>
                    );
                  } else if (!search) {
                    return (
                      <tr key={index}>
                        <td>
                          <div className="py-1">
                            {!isEmpty(item.firstCurrencyImage) && (
                              <Image
                                src={item.firstCurrencyImage}
                                alt="image"
                                className={`rounded-5 ${styles.right_icon} img-fluid`}
                                width={25}
                                height={25}
                              />
                            )}{" "}
                            <span>
                              {item.firstCurrencySymbol}/
                              {item.secondCurrencySymbol}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span className={styles.green_text}>
                            {nWComma(toFixed(item.markPrice, 2))}
                          </span>{" "}
                          <span className={styles.grey_text}>
                            / $
                            {nWComma(toFixed(
                              isEmpty(item.usdtValue)
                                ? item.markPrice
                                : item.usdtValue,
                              2
                            ))}
                          </span>
                        </td>
                        <td className="text-end">
                          <span
                            style={{ color: toFixed(item.change) > 0 ? "green" : "red" }}
                            className={
                              item.change > 0
                                ? styles.green_text
                                : styles.red_text
                            }
                          >
                            {!isEmpty(item?.change)
                              ? toFixed(item.change, 2)
                              : 0}
                            %
                          </span>
                        </td>
                        <td className="text-end">
                          {!isEmpty(item?.high) ? nWComma(toFixed(item.high, 2)) : 0}
                        </td>
                        <td className="text-end px-4">
                          {!isEmpty(item?.low) ? nWComma(toFixed(item.low, 2)) : 0}
                        </td>
                        <td className="text-end">
                          {!isEmpty(item?.secondVolume)
                            ? nWComma(toFixed(item.secondVolume, 2))
                            : 0}
                        </td>
                        <td className="text-end pe-4">
                          <Link
                            href={`/spot/${item.firstCurrencySymbol}_${item.secondCurrencySymbol}`}
                            className={`${styles.green_text} text-decoration-none`}
                          >
                            Trade
                          </Link>
                        </td>
                      </tr>
                    );
                  }
                }
              })}
          </tbody>
        </Table>
      </div>
    </Container>
  );
}
