import Image from "next/image";
import styles from "@/styles/common.module.css";
import { Container, Row, Col } from "react-bootstrap";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import Slider from "react-slick";
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
import AOS from "aos";
import "aos/dist/aos.css";
import Mainnavbar from "../components/navbar";
import dynamic from "next/dynamic";
//import component
const MarketTable = dynamic(() => import("@/components/Market/MarketTable"));
const BannerPage = dynamic(() => import("@/components/Market/bannerPage"));
const PairTable = dynamic(() => import("@/components/Market/PairTable"));
//import lib
import isEmpty from "@/lib/isEmpty";
//improt store
import { useSelector } from "../store";
import { useTheme } from "next-themes";
import { truncateDecimals } from "@/lib/roundOf";

export default function Home() {
  const { theme, setTheme } = useTheme();
  const { siteSetting } = useSelector((state: any) => state.UserSetting.data);
  const { session, user } = useSelector((state: any) => state.auth);

  const [isClient, setIsClient] = useState<boolean>(false);

  const router = useRouter();
  const settings = {
    dots: false,
    infinite: true, // Ensures it loops
    speed: 500, // Speed of the transition (in ms)
    slidesToShow: 4, // Number of items to show in the viewport
    slidesToScroll: 1, // How many items to scroll per swipe
    autoplay: true, // Enable auto-moving
    autoplaySpeed: 3000, // Time between scrolls (3 seconds)
    arrows: false, // Disable the next/prev arrows
  };


  useEffect(() => {
    AOS.init();
    setIsClient(true);
  }, []);
  return (
    <>
      <Mainnavbar />
      <section className={styles.header}>
        {/*
          THE FIRST THING ANYONE LOADS.
          =============================
          MEASURED on a 390px Chromium: the landing page pulled 20.19 MB, and
          19.77 MB of it was this one decorative background loop - 98% of the
          page weight, before a single word of it could be read, on whatever
          connection the visitor happens to have. It was a 20-second 1920x1080
          60fps H.264 at 8.3 Mbit/s, WITH AN AUDIO TRACK, played muted behind a
          headline.

          Re-encoded to 1280x720 at 30fps (CRF 32, audio dropped, faststart):
          648 KB. The material is a dark, out-of-focus blue gradient, which is
          the easiest thing in the world for an encoder and the hardest thing
          for a viewer to fault - frames from the two files are visually
          indistinguishable behind text.

          `poster` is the same still, 19 KB, so the hero is never a black
          rectangle while the loop is fetched; `preload="metadata"` keeps the
          browser from committing to the whole file before it decides to play.
          A companion 28.6 MB "light theme" copy of this video sat in
          public/assets/images/ referenced by nothing at all, and is deleted.
        */}
        <video
          className={styles.headerVideo}
          poster="/assets/images/cryptodexbg-poster.jpg"
          preload="metadata"
          autoPlay
          loop
          muted
          playsInline
        >
          <source src="/assets/images/cryptodexbganimation.mp4" type="video/mp4" />
        </video>
        <Container>
          {/* <div className={styles.banner_float_icons}>
            <Image
              src="/assets/images/banner_icon_01.svg"
              alt="image"
              className="img-fluid"
              width={116}
              height={116}
            />
            <Image
              src="/assets/images/banner_icon_02.svg"
              alt="image"
              className="img-fluid"
              width={126}
              height={126}
            />
            <Image
              src="/assets/images/banner_icon_03.svg"
              alt="image"
              className="img-fluid"
              width={78}
              height={78}
            />
            <Image
              src="/assets/images/banner_icon_04.svg"
              alt="image"
              className="img-fluid"
              width={178}
              height={178}
            />
          </div> */}
          <Row>
            <Col
              md={10}
              xl={8}
              className="m-auto text-center"
              data-aos="fade-up"
              data-aos-delay="300"
            >
              <h1>
                Find the next crypto gem on <span>Cryptodex</span>
              </h1>
              <p className="py-3">
                Where Opportunities Meet Innovation! Discover seamless trading
                experiences, secure transactions, and a world of possibilities
                in the realm of cryptocurrencies.
              </p>

              {!session?.signedIn && (
                <button
                  className={`${styles.animate} ${styles.primary_btn}`}
                  onClick={() => router.push("/register")}
                >
                  <label>Signup Now</label>
                </button>
              )}
            </Col>
          </Row>
        </Container>
      </section>
      {
        isClient && !isEmpty(siteSetting) &&
        <section className={styles.ban_slider}  >
          <BannerPage />
          {/* <Container>
            <div className='slider' >
              <Slider {...settings}>
                <div>
                  <div className={styles.box} data-aos="flip-up" data-aos-duration="1000" >
                    <Image src={siteSetting?.bannerImg1} alt="image" className="img-fluid" width={300} height={150} />
                  </div>
                </div>
                <div>
                  <div className={styles.box} data-aos="flip-up" data-aos-duration="1000" data-aos-delay="300" >
                    <Image src={siteSetting?.bannerImg2} alt="image" className="img-fluid" width={300} height={150} />
                  </div>
                </div>
                <div>
                  <div className={styles.box} data-aos="flip-up" data-aos-duration="1000" data-aos-delay="600" >
                    <Image src={siteSetting?.bannerImg3} alt="image" className="img-fluid" width={300} height={150} />
                  </div>
                </div>
                <div>
                  <div className={styles.box} data-aos="fade-up" data-aos-duration="1000" data-aos-delay="900" >
                    <Image src={siteSetting?.bannerImg4} alt="image" className="img-fluid" width={300} height={150} />
                  </div>
                </div>
              </Slider>
            </div>
          </Container> */}
        </section>
      }
      <MarketTable />

      <section className={`${styles.crypto_exchange}`}>
        <Container>
          <div
            className={`${styles.head} text-start ms-0 w-100 pb-3`}
            data-aos="fade-up"
            data-aos-duration="1000"
          >
            <div className={styles.headFlexContent}>
              <div className={styles.leftTitle}>
                <h2 className={styles.h2tag}>
                  Practice crypto trading without the risk
                </h2>
                <p>
                  Cryptodex is a paper-trading simulator. Every balance is virtual
                  — no deposits, no withdrawals, and no custody of real assets.
                </p>
              </div>
              {!session?.signedIn && (
                <div className={styles.buttonRight}>
                  <button
                    className={`${styles.dark} ${styles.primary_btn} register butn`}
                  >
                    <a href="/register">
                      <label>Sign Up</label>
                    </a>
                  </button>
                </div>
              )}
            </div>
          </div>
          <Row>
            <Col
              lg={4}
              className="d-block d-lg-flex"
              data-aos="flip-up"
              data-aos-duration="1000"
            >
              <div className={`mb-3 mb-lg-0 ${styles.box}`}>
                <div className={styles.inbox}>
                  {theme === "light_theme" ? (
                    <Image
                      src="/assets/images/icon_01_light.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  ) : (
                    <Image
                      src="/assets/images/icon_01.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  )}
                  <h5 className={styles.h5tag}>Start with virtual funds</h5>
                  <p>
                    A free demo balance is credited the moment you sign up.
                  </p>
                </div>
              </div>
            </Col>
            <Col
              lg={4}
              className="d-block d-lg-flex"
              data-aos="flip-up"
              data-aos-duration="1000"
              data-aos-delay="300"
            >
              <div className={`mb-3 mb-lg-0 ${styles.box}`}>
                <div className={styles.inbox}>
                  {theme === "light_theme" ? (
                    <Image
                      src="/assets/images/icon_02_light.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  ) : (
                    <Image
                      src="/assets/images/icon_02.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  )}
                  <h5 className={styles.h5tag}>Nothing real at stake</h5>
                  <p>
                    Orders are simulated against live market data, so a mistake
                    never costs you money.
                  </p>
                </div>
              </div>
            </Col>
            <Col
              lg={4}
              className="d-block d-lg-flex"
              data-aos="flip-up"
              data-aos-duration="1000"
              data-aos-delay="600"
            >
              <div className={`mb-3 mb-lg-0 ${styles.box}`}>
                <div className={styles.inbox}>
                  {theme === "light_theme" ? (
                    <Image
                      src="/assets/images/icon_03_light.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  ) : (
                    <Image
                      src="/assets/images/icon_03.svg"
                      alt="image"
                      className="img-fluid"
                      width={40}
                      height={40}
                    />
                  )}
                  <h5 className={styles.h5tag}>Reset whenever you like</h5>
                  <p>
                    Wiped out your demo balance? Reset your practice account and
                    start again.
                  </p>
                </div>
              </div>
            </Col>
          </Row>
        </Container>
      </section>

      <section className={`${styles.trending_pair}`}>
        {/* <PairTable /> */}
      </section>

      <section className={styles.discover_home}>
        <Container>
          <h2 className={styles.h2tag}>Discover our products</h2>

          <Row className={"mt-5"}>
            <Col lg={4} data-aos="flip-up" data-aos-duration="1000">
              <div className={styles.discover_card}>
                <div className={styles.titleTop}>
                  <h3>Spot</h3>
                  <span
                    onClick={() => router.push(`/spot`)}
                    className={styles.arrowBox}
                  ></span>
                </div>
                <p>
                  Practice on live market data. Buy and sell quickly with
                  automatic calculation of average cost and PnL.
                </p>
              </div>
              {/* One product, one card. A "Discover our products" panel whose
                  links 404 is worse than a short one. The "Markets" card went
                  when /market did: it listed every pair the venue quotes, which
                  is now exactly the one the Spot card above already opens. */}
            </Col>
            <Col lg={8} data-aos="flip-up" data-aos-duration="1000">
              {/* THE ONE PICTURE OF THE PRODUCT ON THE PUBLIC FRONT PAGE, so it
                  has to be this product. It used to be a stock marketing
                  screenshot: unrelated branding, a nav bar of products this
                  venue does not have, and a quote currency it does not list.

                  This is a real screenshot of this venue's own /spot page,
                  taken with Playwright against the running stack: CRYPTODEX, the
                  paper-trading banner, BTC/USD, the live paper ladder in the
                  order book and the live ticket. (It predates the withdrawal
                  of every fee, so the fee panel it shows no longer exists.)

                  It is ONE image, not two. There used to be a `darkImg` and a
                  `lightImg` - but `.darkImg` has no rule in globals.css and
                  `.lightImg` is `display: none` under a selector that applies
                  in every theme, so the light one had never been visible to
                  anybody. The /spot page has no theme switcher and renders dark
                  regardless, so one screenshot is the honest answer. */}
              <div className={styles.discover_img}>
                <Image
                  src="/assets/images/cryptodex_spot_hero.jpg"
                  alt="The Cryptodex spot trading screen: BTC/USD chart, live order book and recent trades, with the paper-trading banner across the top"
                  className="img-fluid"
                  width={812}
                  height={489}
                />
              </div>
            </Col>
          </Row>
        </Container>
      </section>

      <section className={`${styles.home_anytime_anywhere}`}>
        <Container>
          <div className={styles.head}>
            <h2 className="h2tag">Practice. Anytime. Anywhere.</h2>
            <p>
              Sign up for a Cryptodex account today and practice your trading
              strategy with virtual funds only.
            </p>
          </div>
          {!session?.signedIn && (
            <div className={styles.anytime_button_group}>
              <button
                className={`${styles.animate} ${styles.primary_btn}`}
                onClick={() => router.push("/register")}
              >
                <label>Start Paper Trading</label>
              </button>
            </div>
          )}
        </Container>
      </section>
    </>
  );
}
