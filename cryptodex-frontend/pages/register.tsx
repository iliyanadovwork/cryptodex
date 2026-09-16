import styles from '@/styles/common.module.css';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
import { handleAuthSSR } from "../utils/auth";
//import component
const RegisterForm = dynamic(() => import('@/components/Register/Form'))
export default function Register() {

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
          <RegisterForm />
        </div>
      </div>
    </>
  )
}
