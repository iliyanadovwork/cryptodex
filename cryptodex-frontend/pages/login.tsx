
import styles from '@/styles/common.module.css';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import component
import { handleAuthSSR } from "../utils/auth";
const LoginForm = dynamic(() => import('@/components/Login/Form'))
export default function Login() {
  return (
    <>
      <Mainnavbar />
      <div className={styles.login}>
        <video
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/assets/images/cryptodexbg-poster.jpg"
          className={styles.loginBackgroundVideo}
        >
          <source src="/assets/images/cryptodexbganimation.mp4" type="video/mp4" />
        </video>
        <div className={styles.loginContent}>
          <LoginForm />
        </div>
      </div>
    </>
  )
}
