import ExpiredStorage from "expired-storage";

export const getAuthToken = () => {
  if (typeof window !== 'undefined') {
    if (localStorage.getItem("user_token")) {
      return localStorage.getItem("user_token");
    }
    return "";
  }
};

export const removeAuthToken = () => {
  // localStorage.removeItem("email");
  // localStorage.removeItem("password");
  localStorage.removeItem("user_token");
};
export const setAuthToken = async (token) => {
  let expiredStorage = new ExpiredStorage();
  expiredStorage.setItem("user_token", token, 43200); //43200 - 12hrs
  return true;
};

export const setLang = async (value) => {
  localStorage.setItem("lang", value);
  return true;
};

export const setLangname = async (value) => {
  localStorage.setItem("langname", value);
  return true;
};
export const getLangname = () => {
  if (localStorage.getItem('langname')) {
    return localStorage.getItem('langname')
  }
  return '';
}
export const getLang = () => {
  if (localStorage.getItem("lang")) {
    return localStorage.getItem("lang");
  }
  return "";
};

export const setCurrency = async (value) => {
  localStorage.setItem("currency", value);
  return true;
};

export const getCurrency = () => {
  if (localStorage.getItem("currency")) {
    return localStorage.getItem("currency");
  }
  return "";
};

export const setTheme = async (theme) => {
  if (theme == "light") {
    document.body.classList.remove("light_theme");
    document.body.classList.add("dark_theme");
  } else {
    document.body.classList.remove("dark_theme");
    document.body.classList.add("light_theme");
  }
  localStorage.setItem("theme", theme);
  return theme;
};

export const getTheme = () => {
  let theme = localStorage.getItem("theme");
  if (theme) {
    if (theme == "dark") {
      document.body.classList.add("light_theme");
    } else if (theme == "light") {
      document.body.classList.remove("light_theme");
    }
  } else {
    theme = "dark";
  }
  return theme;
};

export const setTradeThemeLocal = async (theme) => {
  localStorage.setItem("theme", theme);
  // localStorage.setItem("tradeTheme", theme);

  return theme;
};

export const changeTradeTheme = (theme) => {
  if (theme == "dark") {
    document.body.classList.add("light_theme");
  } else if (theme == "light") {
    document.body.classList.remove("light_theme");
  }
  return true;
};

export const getTradeTheme = () => {
  let theme = localStorage.getItem("theme");
  // let theme = localStorage.getItem("tradeTheme");

  return theme;
};

// export const setAuthToken = (token) => {
//     localStorage.setItem('user_token', token);
//     return true
// }

// export const setTheme = async (theme) => {
//     if (theme == 'dark') {
//         document.body.classList.add('light_theme');
//     } else {
//         document.body.classList.remove('light_theme');
//     }
//     localStorage.setItem('theme', theme);
//     return theme
// }

// export const setTheme = async (theme) => {
//     console.log("...darkmode",theme)
//     if (theme == "dark") {
//         document.body.classList.remove('light_theme');
//         document.body.classList.add('light_theme');
//     } else {
//         document.body.classList.remove('light_theme');
//         document.body.classList.add('light_theme');

//         document.body.classList.remove('light_theme');
//     }
//     localStorage.setItem('theme', theme);
//     return theme
// }
// export const getTheme = () => {
//     let theme = localStorage.getItem('theme');
//     if (theme) {
//         if (theme == 'dark') {
//             document.body.classList.add('light_theme');
//         } else if (theme == 'light') {
//             document.body.classList.remove('light_theme');
//         }
//     } else {
//         theme = 'light'
//     }
//     return theme;
// }

// export const setTradeTheme = async (theme) => {
//     localStorage.setItem('tradeTheme', theme);
//     return theme
// }
// export const changeTradeTheme = (theme) => {
//     if (theme == "dark") {
//       document.body.classList.add("light_theme");
//     } else if (theme == "light") {
//       document.body.classList.remove("light_theme");
//     }
//     return true;
//   };

// export const changeTradeTheme = (theme) => {
//     if (theme == 'dark') {
//         document.body.classList.add('light_theme');
//         document.body.classList.remove('dark_theme');
//     } else if (theme == 'light') {
//         document.body.classList.add('dark_theme');
//         document.body.classList.remove('light_theme');
//     }
//     return true;
// }

// export const getTradeTheme = () => {
//     let theme = localStorage.getItem('theme');
//     console.log("...theme",theme);
//     return theme
// }
