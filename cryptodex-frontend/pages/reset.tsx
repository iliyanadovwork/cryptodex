
import styles from '@/styles/common.module.css';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import Component
const ResetForm = dynamic(() => import('@/components/Wallet/ResetForm'))
export default function WithdrawPage() {
  return (

    <>
      <Mainnavbar />
      <div className={styles.page_box}>
        <div className={styles.deposit}>
          <ResetForm />
        </div>
      </div>

    </>
  )
}
