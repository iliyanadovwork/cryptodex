import Image from "next/image";
import styles from "@/styles/common.module.css";
import { Container, Row, Col } from "react-bootstrap";
//import component
// Phone/SMS login disabled
// import MobileForm from "../Login/MobileForm";
import EmailForm from "../Login/EmailForm";

export default function LoginForm() {
  return (
    <Container>
      <Row>
        <Col lg={7} xxl={5} className="m-auto">
          <div className={styles.box_flx}>
            <div className={`login_right ${styles.right_box}`}>
              <div className="text-center">
                <h2>Log In</h2>
              </div>
              {/* Phone/SMS login disabled - only email login available */}
              <EmailForm />
            </div>
          </div>
        </Col>
      </Row>
    </Container>
  );
}
