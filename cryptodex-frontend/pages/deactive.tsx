import styles from '@/styles/common.module.css';
import { Container, Row, Col } from 'react-bootstrap';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import component
// Phone/SMS deactivation disabled
// const MobileForm = dynamic(() => import('../components/Deactive/MobileForm'))
const EmailForm = dynamic(() => import('../components/Deactive/EmailForm'))

/**
 * KEPT, NOT DELETED - AND WHY.
 * ============================
 * This was the last screen in the product that still read as a wireframe: a
 * heading, one unlabelled box and a Confirm button, with no sentence anywhere
 * saying what pressing it would do. The tempting fix was to delete it, on the
 * grounds that closing an account on a local paper venue is not worth a page.
 * It is, for two reasons:
 *
 *   1. The backend behind it is real, finished and defended. `deactiveRequest`
 *      and `confirmDeActive` (userapi controllers/user.controller.js) stand the
 *      wallet down, mark the account, purge the redis session and sweep the
 *      spot book, in an order chosen so that no failure can leave an account
 *      half-closed - and userapi tests/unit/account-deactivation.test.js pins
 *      that ordering, the compensation and the scoping-to-req.user.id. Removing
 *      the only way to reach it would leave the most carefully built sequence
 *      in this service unreachable from the product.
 *   2. /security links here, in a row that promises the user this door exists.
 *      Deleting the page turns that row into a 404.
 *
 * So it is finished instead: what deactivation does, which account it will
 * close, the code, and a confirmation the user has to tick. The heading below
 * is deliberately the only thing this file renders around the form - the copy
 * belongs next to the control it describes.
 */
export default function Deactive() {
    return (
        <>
            <Mainnavbar />
            <div className={styles.login}>
                <Container>
                    <Row>
                        <Col lg={11} xxl={9} className='mx-auto'>
                            <div className={styles.box_flx}>
                                <div className={`login_right ${styles.right_box} mx-auto`}>
                                    <h2 className={styles.h2tag} >Account Deactivation</h2>

                                    {/* Phone/SMS deactivation disabled - only email available */}
                                    <EmailForm />

                                </div>
                            </div>

                        </Col>
                    </Row>
                </Container>
            </div>

        </>

    )

}
