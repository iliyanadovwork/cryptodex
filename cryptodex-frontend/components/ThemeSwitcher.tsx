import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { setUserSetting } from "@/store/UserSetting/dataSlice";
import { useDispatch } from "../store";

const ThemeSwitcher: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const dispatch = useDispatch();

  useEffect(() => {
    const storedTheme = localStorage.getItem("theme");
    if (
      storedTheme &&
      (storedTheme === "light_theme" || storedTheme === "dark_theme")
    ) {
      setTheme(storedTheme);
      document.body.setAttribute("data-theme", storedTheme);
      dispatch(
        setUserSetting(
          storedTheme == "light_theme"
            ? { ...{ storedTheme: "dark" } }
            : { ...{ defaultTheme: "light" } }
        )
      );
    } else {
      setTheme("light_theme");
      document.body.setAttribute("data-theme", "light_theme");
      setUserSetting(
        theme == "light_theme"
          ? { ...{ storedTheme: "dark" } }
          : { ...{ storedTheme: "light" } }
      );
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === "light_theme" ? "dark_theme" : "light_theme";
    setTheme(newTheme);
    dispatch(
      setUserSetting(
        newTheme == "light_theme"
          ? { ...{ defaultTheme: "dark" } }
          : { ...{ defaultTheme: "light" } }
      )
    );

    localStorage.setItem("theme", newTheme);
    document.body.setAttribute("data-theme", newTheme);
  };

  return (
    <div className="theme-switcher">
      <button onClick={toggleTheme}>
        {theme === "light_theme" ? (
          <i className="bi bi-moon-fill moon-icon"></i>
        ) : (
          <i className="bi bi-sun-fill sun-icon"></i>
        )}
      </button>
    </div>
  );
};

export default ThemeSwitcher;
