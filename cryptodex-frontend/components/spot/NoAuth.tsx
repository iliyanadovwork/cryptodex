
import { useRouter } from "next/router";
import { memo } from "react";

const NoAuth = () => {
    const router = useRouter();
    return (
        <div className="nodata no-login-spot">
            <h6 className="text-center">
                <span className="cursor-pointer" onClick={() => router.push("/login")}>Log In</span>{" "}
                or {" "}
                <span className="cursor-pointer" onClick={() => router.push("/register")}>Register Now </span>
                {" "} to trade
            </h6>
        </div>
    )
}

export default memo(NoAuth);