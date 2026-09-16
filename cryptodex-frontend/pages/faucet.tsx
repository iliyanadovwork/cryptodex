import styles from '@/styles/common.module.css';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import component with SSR disabled to avoid window/react-toastify errors
const FaucetForm = dynamic(() => import('../components/Wallet/FaucetForm'), {
  ssr: false,
  loading: () => (
    <div className="text-center py-5">
      <i className="fa fa-spinner fa-spin" style={{ fontSize: "32px" }}></i>
      <p className="mt-3">Loading...</p>
    </div>
  )
})


export default function DepositPage() {
  return (

    <>
      <Mainnavbar />
      <div className={styles.page_box}>
        <div className={styles.deposit}>
          <FaucetForm />
        </div>
      </div>

    </>
  )
}