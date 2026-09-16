import React, { useEffect, useState, useRef, useContext } from "react";
import PropTypes from "prop-types";
import { useSelector } from "../../store";
import { useRouter } from "next/router";
import spot from "@/styles/Spot.module.css";
// import lib
import config from "../../config";
import isEmpty from "../../lib/isEmpty";
import SocketContext from "../Context/SocketContext";

// Import the charting library and datafeed to load them globally
import "@/public/static/charting_library/charting_library";
import CustomDatafeed from "@/lib/customDatafeed";
const chartUrl = config.SPOT_API;

const getNetworkStatus = () => (typeof window !== "undefined" ? navigator.onLine : true);

const Chart = (props) => {
  // state
  const { isReady } = useRouter();
  const tvWidgetRef = useRef(null);
  const chartContainerRef = useRef(null);
  const currentSymbolRef = useRef(null); // Track current symbol to avoid recreating
  const [networkStatus, setNetworkStatus] = useState(getNetworkStatus());

  // redux state
  const tradePair = useSelector((state) => state.spot.tradePair);

  // The live trade feed the tape and the price header already run on. The
  // widget is re-created whenever `tradePair._id` changes (see the effect's
  // dependencies), so the datafeed instance always belongs to the pair it was
  // built for and never has to re-target itself.
  const socketContext = useContext(SocketContext);

  const themeDataStore = useSelector(
    (state) => state.UserSetting.data.defaultTheme
  );

  // function
  const getLanguageFromURL = () => {
    const regex = new RegExp("[\\?&]lang=([^&#]*)");
    const results = regex.exec(window.location.search);
    return results === null
      ? null
      : decodeURIComponent(results[1].replace(/\+/g, " "));
  };

  const buildchart = (theme, pair) => {
    // Check if container exists
    const container = chartContainerRef.current;
    if (!container) {
      return;
    }

    // Force dark theme to match site (#0f0f10 grey)
    theme = "Light"; // Use Light theme so we can override all colors manually

    // Skip if already created for this symbol
    if (currentSymbolRef.current === pair && tvWidgetRef.current) {
      return;
    }

    // Clean up existing widget
    if (tvWidgetRef.current) {
      try {
        tvWidgetRef.current.remove();
      } catch (e) {
        // Silently handle removal error
      }
      tvWidgetRef.current = null;
      currentSymbolRef.current = null;
    }

    var widgetOptions = {
      symbol: pair,
      // BEWARE: no trailing slash is expected in feed URL
      datafeed: new CustomDatafeed(props.datafeedUrl, {
        socket: socketContext && socketContext.spotSocket ? socketContext.spotSocket : null,
        pairId: tradePair && tradePair._id ? tradePair._id : null,
      }),
      interval: props.interval,
      container: container, // NEW API: DOM element reference instead of container_id
      library_path: "/static/charting_library/", // NEW: Updated path
      custom_css_url: "/static/charting_library/custom.css", // Load custom color overrides

      locale: getLanguageFromURL() || "en",
      // Compact header mode
      header_widget_buttons_mode: "compact",
      // Disable clutter for cleaner look
      disabled_features: [
        "use_localstorage_for_settings",
        "header_symbol_search",
        "header_screenshot",
        "header_chart_type",
        "header_compare",
        "header_saveload",
        "header_settings",
        "property_pages",
        "show_zoom_and_move_buttons_on_touch",
        "context_menus",
        "border_in_except_toolbar",
        "study_templates",
      ],
      charts_storage_url: props.chartsStorageUrl,
      charts_storage_api_version: props.chartsStorageApiVersion,
      client_id: props.clientId,
      user_id: props.userId,
      fullscreen: props.fullscreen,
      autosize: props.autosize,
      studies_overrides: props.studiesOverrides,
      theme: theme,
      overrides: {
        // Main background - match UI (#0f0f10)
        "paneProperties.background": "#0f0f10",
        "paneProperties.vertGridProperties.color": "rgba(255, 255, 255, 0.04)",
        "paneProperties.horzGridProperties.color": "rgba(255, 255, 255, 0.04)",

        // Scales background and text - match site
        "scalesProperties.backgroundColor": "#0f0f10",
        "scalesProperties.textColor": "rgba(178, 181, 190, 0.7)",
        "scalesProperties.fontSize": 12,

        // Crosshair - subtle styling
        "paneProperties.crossHairProperties.color": "rgba(120, 123, 134, 0.6)",
        "paneProperties.crossHairProperties.width": 1,
        "paneProperties.crossHairProperties.style": 2,
        "paneProperties.crossHairProperties.labelBackgroundColor": "#0f0f10",
        "paneProperties.crossHairProperties.labelTextColor": "rgba(178, 181, 190, 0.9)",
        "paneProperties.crossHairProperties.priceLabelBackgroundColor": "rgba(15, 15, 16, 0.95)",
        "paneProperties.crossHairProperties.priceLabelBorderColor": "transparent",

        // Candle colors - match site green/red
        "mainSeriesProperties.candleStyle.upColor": "#26a69a",
        "mainSeriesProperties.candleStyle.downColor": "#ef5350",
        "mainSeriesProperties.candleStyle.borderUpColor": "#26a69a",
        "mainSeriesProperties.candleStyle.borderDownColor": "#ef5350",
        "mainSeriesProperties.candleStyle.wickUpColor": "#26a69a",
        "mainSeriesProperties.candleStyle.wickDownColor": "#ef5350",

        // Price line
        "mainSeriesProperties.priceLineColor": "rgba(120, 123, 134, 0.4)",
        "mainSeriesProperties.priceLineWidth": 1,
        "mainSeriesProperties.lastPriceAnimationDuration": 300,

        // Status line margins
        "paneProperties.topMargin": 15,
        "paneProperties.bottomMargin": 5,

        // Legend styling
        "paneProperties.legendProperties.showLegend": true,
        "paneProperties.legendProperties.showVolume": true,
        "paneProperties.legendProperties.showBarChange": true,
        "paneProperties.legendProperties.legendBackground": "#0f0f10",

        // Hides (remove unwanted elements)
        "paneProperties.legendProperties.showStudyTitles": false,

        // Volume colors
        "mainSeriesProperties.volumeStyle.color": "#2962ff",
        "mainSeriesProperties.volumeStyle.transparency": 70,

        // Time scale
        "scalesProperties.seriesLeftScale": 0,
        "scalesProperties.seriesRightScale": 1,
        "scalesProperties.scaleMarginsLeft": 0.0001,
        "scalesProperties.scaleMarginsRight": 0.0001,

        // Additional background overrides
        "paneProperties.topMargin": 15,
        "paneProperties.bottomMargin": 5,

        // Force all panes to use dark background
        "paneProperties.background": "#0f0f10",
        "paneProperties.horzGridProperties.color": "rgba(255, 255, 255, 0.04)",
        "paneProperties.vertGridProperties.color": "rgba(255, 255, 255, 0.04)",

        // Header/toolbar colors
        "toolbarProperties.background": "#0f0f10",
        "headerProperties.background": "#0f0f10",

        // Remove borders
        "paneProperties.borderColor": "transparent",
        "scalesProperties.borderColor": "transparent",
      },
    };

    const tvWidget = new window.TradingView.widget(widgetOptions);
    tvWidgetRef.current = tvWidget;
    currentSymbolRef.current = pair;

    tvWidget.onChartReady(() => {
      // Force dark colors on all chart elements via JavaScript
      const forceDarkColors = () => {
        const container = chartContainerRef.current;
        if (!container) return;

        // Get all elements within the chart and override backgrounds
        const allElements = container.querySelectorAll('*');
        allElements.forEach(el => {
          const computedStyle = window.getComputedStyle(el);
          const bgColor = computedStyle.backgroundColor;

          // Check if element has white or near-white background
          if (bgColor === 'rgb(255, 255, 255)' ||
              bgColor === 'rgb(254, 254, 254)' ||
              bgColor === 'rgb(253, 253, 253)' ||
              bgColor === '#ffffff' ||
              bgColor === '#fff' ||
              bgColor === '#fefefe' ||
              bgColor === '#fdfdfd') {
            el.style.setProperty('background-color', '#0f0f10', 'important');
          }

          // Also target dynamic TradingView classes
          const className = el.className || '';
          if (typeof className === 'string' &&
              (className.includes('separatorWrap') ||
               className.includes('fill-') ||
               className.includes('wrap-') ||
               className.includes('group'))) {
            el.style.setProperty('background-color', '#0f0f10', 'important');
          }
        });

        // Also set inline styles on known white elements
        const toolbars = container.querySelectorAll('[class*="toolbar"], [class*="Toolbar"], header, nav, [class*="separator"], [class*="fill-"], [class*="wrap-"]');
        toolbars.forEach(el => {
          el.style.setProperty('background-color', '#0f0f10', 'important');
        });
      };

      // Run immediately and periodically
      forceDarkColors();
      const colorInterval = setInterval(forceDarkColors, 500);

      // Clear interval after 10 seconds
      setTimeout(() => clearInterval(colorInterval), 10000);

      tvWidget.headerReady().then(() => {
        const button = tvWidget.createButton();
        button.setAttribute("title", "Click to show a notification popup");
        button.classList.add("apply-common-tooltip");
        button.addEventListener("click", () =>
          tvWidget.showNoticeDialog({
            title: "Notification",
            body: "TradingView Charting Library API works correctly",
            callback: () => {},
          })
        );

        // button.innerHTML = 'Check API';
      });
    });
  };

  // Single consolidated useEffect for chart creation
  useEffect(() => {
    if (!isReady) return;
    if (typeof window === "undefined") return;
    // Handles the cleanup below cancels. Declared out here so they exist on
    // every path, including the one where the guard below is false.
    let startTimer = null;
    let retryTimer = null;
    let sizeObserver = null;

    if (!isEmpty(tradePair) && !isEmpty(tradePair._id) && networkStatus) {
      let symbol = tradePair.firstCurrencySymbol + tradePair.secondCurrencySymbol;
      // Set theme based on site's theme - dark mode site = dark theme chart
      let themeValue = (themeDataStore == "dark") ? "Dark" : "Light";

      // WAIT for the container to have dimensions - do not POLL for them.
      //
      // This used to re-arm `setTimeout(createChartWhenReady, 100)` from inside
      // itself, with no handle kept and nothing cancelling it. For the chart in
      // the layout that is currently display:none - and BOTH layouts are always
      // mounted, so on desktop the mobile chart always is - offsetWidth is 0 and
      // stays 0, so the loop never succeeded and never stopped: a permanent
      // 10 Hz timer reading offsetWidth (which forces layout) for the life of
      // the page, per hidden chart, surviving every pair switch because the
      // cleanup below could not cancel what it had no handle to.
      //
      // A ResizeObserver costs nothing while the box has no size and fires the
      // moment it gets one, which is exactly the event being polled for.
      const tryBuild = () => {
        const container = chartContainerRef.current;
        if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
          buildchart(themeValue, symbol);
          return true;
        }
        return false;
      };

      startTimer = setTimeout(() => {
        if (tryBuild()) return;
        if (typeof ResizeObserver !== "undefined" && chartContainerRef.current) {
          sizeObserver = new ResizeObserver(() => {
            if (tryBuild()) {
              sizeObserver.disconnect();
              sizeObserver = null;
            }
          });
          sizeObserver.observe(chartContainerRef.current);
        } else {
          // No ResizeObserver (very old browser, jsdom): fall back to polling,
          // but BOUNDED - it gives up rather than running forever.
          let attempts = 0;
          const poll = () => {
            if (tryBuild() || ++attempts > 50) return;
            retryTimer = setTimeout(poll, 100);
          };
          poll();
        }
      }, 100);
    }

    // Cleanup function
    return () => {
      clearTimeout(startTimer);
      clearTimeout(retryTimer);
      if (sizeObserver) {
        sizeObserver.disconnect();
        sizeObserver = null;
      }
      if (tvWidgetRef.current) {
        try {
          tvWidgetRef.current.remove();
        } catch (e) {
          // Silently handle cleanup error
        }
        tvWidgetRef.current = null;
        currentSymbolRef.current = null;
      }
    };
  }, [tradePair?._id, themeDataStore, networkStatus, isReady]);

  // Network status listeners
  useEffect(() => {
    const updateStatus = () => setNetworkStatus(navigator.onLine);

    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);

    return () => {
      window.removeEventListener("online", updateStatus);
      window.removeEventListener("offline", updateStatus);
    };
  }, []);

  return (
    <div
      ref={chartContainerRef}
      className={spot.chart_inner_div}
      id="tv_chart_container"
      style={{
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
      }}
    />
  );
};

Chart.propTypes = {
  symbol: PropTypes.string.isRequired,
  interval: PropTypes.string.isRequired,
  containerId: PropTypes.string.isRequired,
  datafeedUrl: PropTypes.string.isRequired,
  libraryPath: PropTypes.string.isRequired,
  chartsStorageUrl: PropTypes.string.isRequired,
  chartsStorageApiVersion: PropTypes.string.isRequired,
  clientId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  // These are booleans/objects (see defaultProps and the TradingView widget
  // options they feed), not strings.
  fullscreen: PropTypes.bool.isRequired,
  autosize: PropTypes.bool.isRequired,
  studiesOverrides: PropTypes.object.isRequired,
  theme: PropTypes.string.isRequired,
  pair: PropTypes.string.isRequired,
};

Chart.defaultProps = {
  symbol: "BTCUSD",
  interval: "1",
  containerId: "tv_chart_container",
  datafeedUrl: chartUrl + "/api/spot/chart",
  libraryPath: "/static/charting_library/",
  chartsStorageUrl: "",
  chartsStorageApiVersion: "1.1",
  clientId: "tradingview.com",
  userId: "public_user_id",
  fullscreen: false,
  autosize: true,
  studiesOverrides: {},
  theme: "Light",
  pair: "BTCUSD",
};

export default Chart;
